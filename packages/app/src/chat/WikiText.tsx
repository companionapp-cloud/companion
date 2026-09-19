import { useContext, useEffect, useState, type ReactNode } from "react";
import { StyleSheet, Text as RNText } from "react-native";
import { colors, font } from "@companion/design-system";
import { useCore } from "../CoreContext";
import { OpenEntityContext, ThreadLayoutContext } from "./context";

// --- wikilink rendering ----------------------------------------------------

const WIKILINK = /!?\[\[(note|task|habit|project|canvas):([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** Chat prose with its [[type:id]] wikilinks drawn as clickable chips titled live. */
export function WikiText({ value }: { value: string }) {
  const threadLayout = useContext(ThreadLayoutContext);
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  WIKILINK.lastIndex = 0;
  let key = 0;
  while ((m = WIKILINK.exec(value)) !== null) {
    if (m.index > last) parts.push(<RNText key={key++}>{value.slice(last, m.index)}</RNText>);
    parts.push(<LinkChip key={key++} type={m[1]} id={m[2]} />);
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push(<RNText key={key++}>{value.slice(last)}</RNText>);
  return <RNText style={[styles.body, threadLayout === "bubbles" ? styles.bodyBubble : null]}>{parts}</RNText>;
}

function LinkChip({ type, id }: { type: string; id: string }) {
  const { graph } = useCore();
  const openEntity = useContext(OpenEntityContext);
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    graph
      .lookup(id)
      .then((n) => {
        if (alive) setTitle(n?.title ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [graph, id]);
  return (
    <RNText style={styles.chip} onPress={() => openEntity?.(type, id)}>
      {title ?? type}
    </RNText>
  );
}

const styles = StyleSheet.create({
  body: { fontFamily: font.sans, fontSize: font.size.md, lineHeight: 21, color: colors.textPrimary },
  bodyBubble: { lineHeight: 20 },
  chip: { color: colors.textAccent, fontWeight: font.weight.medium, textDecorationLine: "underline", textDecorationColor: colors.accentSoftBorder },
});
