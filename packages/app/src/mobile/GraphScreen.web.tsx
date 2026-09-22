import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { Graph } from "@companion/core-bridge";
import { Button, Icon, Text, colors, row, space, type IconName } from "@companion/design-system";
import { useCore } from "../CoreContext";
import { useOpenGraphNode } from "../openGraphNode";
import { useStyledGraph } from "../useStyledGraph";
import { typeColor } from "../graphModel";
// Explicit .web specifier — see the note in ../GraphScreen.web.tsx.
import { GraphEmpty, GraphView, graphCodeStyle, type GraphSelection } from "../GraphView.web";
import { TourAnchor } from "../onboarding/anchors";
import { NavBar } from "./ui";

// The whole-knowledgebase graph on mobile web: the same d3-force view the desktop renders,
// under a nav bar. A phone has no hover, so a tapped node doesn't navigate — it reports
// itself in a bottom bar (type icon, title, mono type) with an Open action. Every node
// kind selects; a tap on the empty pane clears it.

const TYPE_ICON: Record<string, IconName> = { note: "notes", task: "tasks", project: "folder", canvas: "canvas", document: "file" };

export function GraphScreen() {
  const { core, graph: graphApi } = useCore();
  // Opens a node where it lives, e.g. Today for a daily note.
  const openNode = useOpenGraphNode();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const styledGraph = useStyledGraph(graph);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<GraphSelection | null>(null);
  // Node/link totals as the view's Show filters leave them, for the idle bar.
  const [counts, setCounts] = useState({ nodes: 0, links: 0 });

  const refresh = useCallback(async () => {
    setGraph(await graphApi.full());
    setLoaded(true);
  }, [graphApi]);

  useEffect(() => {
    void refresh();
    // Stay live as notes are edited, synced, or the index is rebuilt (PLAN §5.4).
    return core.on("data.changed", () => void refresh());
  }, [core, refresh]);

  // The tapped node, re-resolved against the live graph so a rename shows. Ghosts
  // (unresolved link targets) aren't in it, so those fall back to the selection's own label.
  const node = useMemo(
    () => (selected ? (styledGraph.nodes.find((n) => n.type === selected.type && n.id === selected.id) ?? null) : null),
    [selected, styledGraph.nodes],
  );
  // Ghosts have nothing behind them, and documents have no screen of their own.
  const canOpen = !!selected && !selected.ghost && selected.type !== "document";

  const open = () => {
    if (selected && canOpen) openNode?.(selected.type, selected.id);
  };

  const empty = loaded && graph.nodes.length === 0;

  return (
    <View style={styles.root}>
      <NavBar title="Graph" />
      <TourAnchor id="graph.canvas" style={styles.canvas}>
        {empty ? (
          <GraphEmpty>
            Your graph is empty. Create a few notes and link them with{" "}
            <code style={graphCodeStyle}>[[note:&lt;id&gt;]]</code> — linked notes will appear here connected.
          </GraphEmpty>
        ) : (
          <GraphView graph={styledGraph} menu onSelectNode={setSelected} selectedKey={selected?.key ?? null} onCounts={setCounts} />
        )}
      </TourAnchor>
      {empty ? null : (
        <View style={styles.bar}>
          {selected ? (
            <>
              <Icon
                name={((node?.objectIcon as IconName | null | undefined) ?? TYPE_ICON[selected.type] ?? "dot") as IconName}
                size={16}
                color={selected.ghost ? colors.textTertiary : (node?.objectColor ?? typeColor(selected.type))}
              />
              <View style={styles.barBody}>
                <Text variant="label" numberOfLines={1}>
                  {node?.title || selected.label || "Untitled"}
                </Text>
                <Text variant="mono" tone="quaternary" numberOfLines={1}>
                  {selected.ghost ? "unresolved" : selected.type} · {selected.degree === 1 ? "1 link" : `${selected.degree} links`}
                </Text>
              </View>
              {canOpen ? <Button label="Open" variant="secondary" onPress={open} /> : null}
            </>
          ) : (
            <Text variant="mono" tone="quaternary" numberOfLines={1}>
              {counts.nodes} nodes · {counts.links} links · tap a node
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  // RNW View is position:relative, giving the absolutely-filled graph canvas a size.
  canvas: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  bar: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: row.touch,
    paddingHorizontal: space.ml,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  barBody: { flex: 1, minWidth: 0, gap: 1 },
});
