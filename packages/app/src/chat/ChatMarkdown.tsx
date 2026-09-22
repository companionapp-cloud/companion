import { useContext, useMemo, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text as RNText, View } from "react-native";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { colors, font, radius, space } from "@companion/design-system";
import { openExternalUrl } from "../externalUrl";
import { ThreadLayoutContext } from "./context";
import { LinkChip } from "./WikiText";

// --- parser ----------------------------------------------------------------

// Raw HTML stays text (a reply can't inject markup); GFM tables and strikethrough are on;
// bare URLs become links.
const md = new MarkdownIt("default", { html: false, linkify: true, breaks: true });

const WIKILINK_AT = /^!?\[\[(note|task|habit|project|canvas):([^\]|]+)(?:\|[^\]]+)?\]\]/;

// [[type:id]] references are their own inline token, so emphasis or link rules never reach
// inside one (ids can carry `_`), and the renderer draws them as the thread's chips.
md.inline.ruler.before("link", "wikilink", (state: StateInline, silent: boolean) => {
  const ch = state.src.charCodeAt(state.pos);
  if (ch !== 0x5b /* [ */ && ch !== 0x21 /* ! */) return false;
  const m = WIKILINK_AT.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) {
    const t = state.push("wikilink", "", 0);
    t.meta = { type: m[1], id: m[2] };
  }
  state.pos += m[0].length;
  return true;
});

type MdNode = { token: Token; children: MdNode[] };

/** nest folds markdown-it's flat open/close stream into a tree. */
function nest(tokens: Token[]): MdNode[] {
  const root: MdNode[] = [];
  const stack: MdNode[][] = [root];
  for (const token of tokens) {
    if (token.nesting === -1) {
      stack.pop();
      continue;
    }
    const node: MdNode = { token, children: token.children ? nest(token.children) : [] };
    stack[stack.length - 1].push(node);
    if (token.nesting === 1) stack.push(node.children);
  }
  return root;
}

// --- rendering -------------------------------------------------------------

/** An assistant reply as formatted markdown: headings, lists, quotes, code, tables and links,
 *  with [[type:id]] references drawn as clickable, draggable chips. Safe to feed a reply that
 *  is still streaming — an unclosed fence or list just renders as far as it has got. */
export function ChatMarkdown({ value }: { value: string }) {
  const threadLayout = useContext(ThreadLayoutContext);
  const tree = useMemo(() => nest(md.parse(value, {})), [value]);
  const bubble = threadLayout === "bubbles";
  return <View style={styles.root}>{renderBlocks(tree, { bubble })}</View>;
}

type Ctx = { bubble: boolean };

function renderBlocks(nodes: MdNode[], ctx: Ctx): ReactNode[] {
  return nodes.map((n, i) => renderBlock(n, i, ctx));
}

function renderBlock(node: MdNode, key: number, ctx: Ctx): ReactNode {
  const { token: t, children } = node;
  const body = [styles.body, ctx.bubble ? styles.bodyBubble : null];
  switch (t.type) {
    case "paragraph_open":
      return (
        <RNText key={key} style={body}>
          {renderInlineNodes(children)}
        </RNText>
      );
    case "inline":
      return (
        <RNText key={key} style={body}>
          {renderInline(node)}
        </RNText>
      );
    case "heading_open": {
      const level = Number(t.tag.slice(1));
      return (
        <RNText key={key} style={[body, styles.heading, level <= 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3]}>
          {renderInlineNodes(children)}
        </RNText>
      );
    }
    case "bullet_list_open":
    case "ordered_list_open": {
      const ordered = t.type === "ordered_list_open";
      const start = Number(t.attrGet("start") ?? 1);
      return (
        <View key={key} style={styles.list}>
          {children.map((item, i) => (
            <View key={i} style={styles.listItem}>
              <RNText style={[body, styles.marker, ordered ? styles.markerOrdered : null]}>{ordered ? `${start + i}.` : "•"}</RNText>
              <View style={styles.listBody}>{renderBlocks(item.children, ctx)}</View>
            </View>
          ))}
        </View>
      );
    }
    case "blockquote_open":
      return (
        <View key={key} style={styles.quote}>
          {renderBlocks(children, ctx)}
        </View>
      );
    case "fence":
    case "code_block":
      return (
        <ScrollView key={key} horizontal style={styles.codeBlock} contentContainerStyle={styles.codeBlockInner}>
          <RNText style={styles.codeBlockText}>
            {t.content.replace(/\n$/, "")}
          </RNText>
        </ScrollView>
      );
    case "hr":
      return <View key={key} style={styles.hr} />;
    case "table_open":
      return <Table key={key} node={node} ctx={ctx} />;
    default:
      return children.length ? <View key={key}>{renderBlocks(children, ctx)}</View> : null;
  }
}

function Table({ node, ctx }: { node: MdNode; ctx: Ctx }) {
  const rows: { header: boolean; cells: MdNode[] }[] = [];
  for (const section of node.children) {
    for (const tr of section.children) {
      rows.push({ header: section.token.type === "thead_open", cells: tr.children });
    }
  }
  return (
    <ScrollView horizontal style={styles.table}>
      <View>
        {rows.map((r, i) => (
          <View key={i} style={[styles.tr, i > 0 ? styles.trDivider : null, r.header ? styles.thRow : null]}>
            {r.cells.map((c, j) => (
              <RNText key={j} style={[styles.body, ctx.bubble ? styles.bodyBubble : null, styles.td, r.header ? styles.th : null]}>
                {renderInlineNodes(c.children)}
              </RNText>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** A block's children are a single `inline` node; this renders its spans. */
function renderInlineNodes(nodes: MdNode[]): ReactNode[] {
  return nodes.map((n, i) => (n.token.type === "inline" ? <RNText key={i}>{renderInline(n)}</RNText> : null));
}

function renderInline(node: MdNode): ReactNode[] {
  return node.children.map((n, i) => renderSpan(n, i));
}

function renderSpan(node: MdNode, key: number): ReactNode {
  const { token: t, children } = node;
  const inner = () => children.map((c, i) => renderSpan(c, i));
  switch (t.type) {
    case "text":
      return t.content;
    case "softbreak":
    case "hardbreak":
      return "\n";
    case "code_inline":
      return (
        <RNText key={key} style={styles.codeInline}>
          {t.content}
        </RNText>
      );
    case "strong_open":
      return (
        <RNText key={key} style={styles.strong}>
          {inner()}
        </RNText>
      );
    case "em_open":
      return (
        <RNText key={key} style={styles.em}>
          {inner()}
        </RNText>
      );
    case "s_open":
      return (
        <RNText key={key} style={styles.strike}>
          {inner()}
        </RNText>
      );
    case "link_open": {
      const href = t.attrGet("href") ?? "";
      return (
        <RNText key={key} style={styles.link} onPress={() => void openExternalUrl(href).catch(() => undefined)}>
          {inner()}
        </RNText>
      );
    }
    case "wikilink":
      return <LinkChip key={key} type={t.meta.type} id={t.meta.id} />;
    case "image":
      // No inline images in the thread; show the alt text as a link to the image.
      return (
        <RNText key={key} style={styles.link} onPress={() => void openExternalUrl(t.attrGet("src") ?? "").catch(() => undefined)}>
          {t.content || t.attrGet("src")}
        </RNText>
      );
    default:
      return children.length ? <RNText key={key}>{inner()}</RNText> : t.content || null;
  }
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  body: { fontFamily: font.sans, fontSize: font.size.md, lineHeight: 21, color: colors.textPrimary },
  bodyBubble: { lineHeight: 20 },
  heading: { fontWeight: font.weight.semibold, letterSpacing: font.tracking.snug },
  h1: { fontSize: font.size.xl, lineHeight: 24 },
  h2: { fontSize: font.size.lg, lineHeight: 22 },
  h3: { fontSize: font.size.md, lineHeight: 21 },
  strong: { fontWeight: font.weight.semibold },
  em: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  link: { color: colors.textAccent, textDecorationLine: "underline", textDecorationColor: colors.accentSoftBorder },
  codeInline: {
    fontFamily: font.mono,
    fontSize: font.size.sm,
    backgroundColor: colors.surfaceCode,
    borderRadius: radius.xs,
    paddingHorizontal: space.xxs,
  },
  codeBlock: { backgroundColor: colors.surfaceCode, borderColor: colors.borderSubtle, borderWidth: 1, borderRadius: radius.lg },
  codeBlockInner: { paddingVertical: space.md, paddingHorizontal: space.lg },
  codeBlockText: { fontFamily: font.mono, fontSize: font.size.sm, lineHeight: 18, color: colors.textPrimary },
  list: { gap: space.xs },
  listItem: { flexDirection: "row", gap: space.sm },
  marker: { color: colors.textTertiary, minWidth: 10 },
  markerOrdered: { fontFamily: font.mono, fontSize: font.size.sm, minWidth: 18, textAlign: "right" },
  listBody: { flex: 1, minWidth: 0, gap: space.xs },
  quote: { borderLeftWidth: 2, borderLeftColor: colors.borderDefault, paddingLeft: space.lg, gap: space.md },
  hr: { height: 1, backgroundColor: colors.borderSubtle, marginVertical: space.xs },
  table: { alignSelf: "flex-start", maxWidth: "100%", borderColor: colors.borderSubtle, borderWidth: 1, borderRadius: radius.lg, flexGrow: 0 },
  tr: { flexDirection: "row" },
  trDivider: { borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  thRow: { backgroundColor: colors.surfaceSunken },
  td: { width: 160, paddingVertical: space.xs, paddingHorizontal: space.md },
  th: { fontWeight: font.weight.semibold },
});
