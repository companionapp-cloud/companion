import { useMemo, useState } from "react";
import { StyleSheet, Text as RNText, View, type LayoutChangeEvent } from "react-native";
import type { CanvasDocument, CanvasNode } from "@companion/core-bridge";
import { colors, font, radius } from "@companion/design-system";
import type { Rect } from "../canvas/geometry";
import { CanvasEdges } from "./CanvasEdges";
import { edgeShapes, fitBoard, project, wash, type Fit } from "./thumbnailGeometry";

// The board's own colors (CanvasView.web.tsx): each embedded kind's accent stripe, and the
// default swatches of stickies and groups.
const KIND_COLOR: Record<string, string> = { note: colors.success, task: colors.info, event: colors.textPrimary, image: colors.textTertiary, link: colors.textTertiary };
const STICKY = "#eab308";
const GROUP = "#64748b";
const LINE = 12;

/** A read-only miniature of a board for the chat: its groups, cards and arrows where they sit on
 *  the canvas, scaled to fit the card it's in. A card shows its title — or a sticky its text — once
 *  it's big enough to read; below that it's a shape, which still gives the board's layout at a
 *  glance. Everything is drawn from the one `canvases.get` document, so it's cheap to keep live. */
export function CanvasThumbnail({ doc, minHeight = 120, maxHeight = 260 }: { doc: CanvasDocument; minHeight?: number; maxHeight?: number }) {
  const [width, setWidth] = useState(0);
  const fit = useMemo(() => fitBoard(doc.nodes, width, minHeight, maxHeight), [doc.nodes, width, minHeight, maxHeight]);
  const shapes = useMemo(() => (fit ? edgeShapes(doc.nodes, doc.edges, fit) : []), [doc.nodes, doc.edges, fit]);
  // Groups lie behind the arrows and the arrows behind the cards, as on the board.
  const [groups, cards] = useMemo(() => {
    const byZ = (a: CanvasNode, b: CanvasNode) => a.z - b.z;
    return [doc.nodes.filter((n) => n.kind === "group").sort(byZ), doc.nodes.filter((n) => n.kind !== "group").sort(byZ)];
  }, [doc.nodes]);
  // onLayout works on both platforms but isn't in the shared RN typings, hence the cast (as with
  // ChatScreen's focus props).
  const layoutProps = { onLayout: (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width) } as Record<string, unknown>;
  return (
    <View {...layoutProps} style={[styles.box, { height: fit?.height ?? minHeight }]}>
      {fit ? (
        <>
          {groups.map((g) => (
            <GroupShape key={g.id} node={g} rect={project(g, fit)} fit={fit} />
          ))}
          <CanvasEdges shapes={shapes} width={fit.width} height={fit.height} />
          {cards.map((n) => (
            <CardShape key={n.id} node={n} rect={project(n, fit)} fit={fit} doc={doc} />
          ))}
        </>
      ) : null}
    </View>
  );
}

function GroupShape({ node, rect, fit }: { node: CanvasNode; rect: Rect; fit: Fit }) {
  const color = node.color ?? GROUP;
  const label = typeof node.data?.label === "string" ? node.data.label : "";
  return (
    <View
      style={[
        styles.shape,
        box(rect),
        {
          borderRadius: Math.max(2, radius.lg * fit.scale),
          borderColor: wash(color, 0.45) ?? colors.borderDefault,
          backgroundColor: wash(color, 0.07) ?? colors.surfaceSunken,
        },
      ]}
    >
      {/* Notched into the top edge, as the board draws it. */}
      {label && rect.width > 40 ? (
        <RNText numberOfLines={1} style={[styles.groupLabel, { maxWidth: rect.width - 12 }]}>
          {label}
        </RNText>
      ) : null}
    </View>
  );
}

function CardShape({ node, rect, fit, doc }: { node: CanvasNode; rect: Rect; fit: Fit; doc: CanvasDocument }) {
  const radiusPx = Math.max(2, radius.md * fit.scale);
  const { text, done, gone } = cardText(node, doc);
  const lines = Math.min(4, Math.floor((rect.height - 4) / LINE));
  const readable = rect.width >= 30 && lines >= 1 && text !== "";
  if (node.kind === "text") {
    const color = node.color ?? STICKY;
    return (
      <View style={[styles.shape, styles.card, box(rect), { borderRadius: radiusPx, borderColor: color }]}>
        {/* The swatch washed over the card surface, so a sticky reads the same over a group. */}
        <View style={[styles.fill, { backgroundColor: wash(color, 0.18) ?? colors.surfaceCard }]} />
        {readable ? (
          <RNText numberOfLines={lines} style={styles.stickyText}>
            {text}
          </RNText>
        ) : null}
      </View>
    );
  }
  return (
    <View
      style={[
        styles.shape,
        styles.card,
        box(rect),
        { borderRadius: radiusPx, borderLeftWidth: 2, borderLeftColor: node.color ?? KIND_COLOR[node.kind] ?? colors.textTertiary },
      ]}
    >
      {readable ? (
        <RNText
          numberOfLines={lines}
          style={[styles.cardTitle, done ? styles.done : null, gone ? styles.gone : null]}
        >
          {text}
        </RNText>
      ) : null}
    </View>
  );
}

/** What a card says in the miniature: a sticky's text, or the title of what it embeds. */
function cardText(node: CanvasNode, doc: CanvasDocument): { text: string; done?: boolean; gone?: boolean } {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const ref = node.refId ?? "";
  switch (node.kind) {
    case "text":
      return { text: str(data.text) };
    case "note": {
      const n = doc.refs.notes[ref];
      return !n || n.missing ? { text: "Note gone", gone: true } : { text: n.title || "Untitled" };
    }
    case "task": {
      const t = doc.refs.tasks[ref];
      return !t || t.missing ? { text: "Task gone", gone: true } : { text: t.title || "Untitled task", done: t.status === "done" };
    }
    case "event": {
      const e = doc.refs.events[ref];
      return e && !e.missing ? { text: e.title } : { text: str(data.title) || "Event", gone: true };
    }
    case "image": {
      const d = doc.refs.documents[ref];
      return { text: d && !d.missing ? d.filename : "Image" };
    }
    case "link":
      return { text: str(data.title) || hostOf(str(data.url)) || "Link" };
    default:
      return { text: "" };
  }
}

function hostOf(url: string): string {
  const m = /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(url);
  return m ? m[1] : url;
}

const box = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });

const styles = StyleSheet.create({
  // Nothing in a miniature is interactive: a press anywhere belongs to the card around it.
  box: { width: "100%", overflow: "hidden", backgroundColor: colors.surfaceCard, pointerEvents: "none" },
  shape: { position: "absolute", borderWidth: 1 },
  card: { backgroundColor: colors.surfaceCard, borderColor: colors.borderSubtle, overflow: "hidden", paddingHorizontal: 3, paddingVertical: 1 },
  fill: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 },
  groupLabel: {
    position: "absolute",
    top: -7,
    left: 5,
    paddingHorizontal: 3,
    backgroundColor: colors.surfaceCard,
    color: colors.textTertiary,
    fontFamily: font.mono,
    fontSize: font.size["2xs"],
    lineHeight: 13,
  },
  stickyText: { fontFamily: font.sans, fontSize: font.size["2xs"], lineHeight: LINE, color: colors.textPrimary },
  cardTitle: { fontFamily: font.sans, fontSize: font.size["2xs"], lineHeight: LINE, fontWeight: font.weight.medium, color: colors.textPrimary },
  done: { color: colors.textTertiary, textDecorationLine: "line-through" },
  gone: { color: colors.textTertiary, fontStyle: "italic" },
});
