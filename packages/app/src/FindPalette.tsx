import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Icon, Kbd, ListRow, Text, colors, font, icon, radius, shadow, space, useDensity, type IconName } from "@companion/design-system";
import { paletteEnter } from "./paletteEnter";
import { Overlay } from "./Overlay";

// A "find something in this view" palette — the canvas's ⌘K card search and the graph's node
// search. The agenda palette's card (AgendaPalette.tsx), cut down to one job: type to filter,
// ↑↓ to walk the matches, ⏎ to jump to one, esc to close.

export interface FindItem {
  key: string;
  /** The group it's listed under ("notes", "stickies", …); consecutive items share a heading. */
  section: string;
  icon: IconName;
  /** Tints the row's icon (a graph node's archetype color); the quiet ink otherwise. */
  iconColor?: string;
  title: string;
  trailing?: string;
  /** Extra text the query matches besides the title (a sticky's full text, a link's URL). */
  keywords?: string;
}

/** Items matching every word of the query, in their given order. The titles that start
 *  with the query come first, so "road" lands on "Roadmap" before "Side roads". */
function filterItems(items: FindItem[], query: string): FindItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const hits = items.filter((it) => {
    const hay = `${it.title} ${it.keywords ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const head = words.join(" ");
  const starts = (it: FindItem) => (it.title.toLowerCase().startsWith(head) ? 0 : 1);
  // Grouped by section still: rank within each section, keeping the sections' order.
  const sectionOrder = new Map<string, number>();
  hits.forEach((it) => sectionOrder.has(it.section) || sectionOrder.set(it.section, sectionOrder.size));
  return hits
    .map((it, i) => ({ it, i }))
    .sort((a, b) => sectionOrder.get(a.it.section)! - sectionOrder.get(b.it.section)! || starts(a.it) - starts(b.it) || a.i - b.i)
    .map((x) => x.it);
}

/** Long lists are capped: the palette is for jumping, not browsing. */
const MAX_ROWS = 60;

export function FindPalette({
  items,
  placeholder,
  emptyText,
  onPick,
  onClose,
}: {
  items: FindItem[];
  placeholder: string;
  /** Shown when nothing matches (or there is nothing to find). */
  emptyText: string;
  onPick: (item: FindItem) => void;
  onClose: () => void;
}) {
  const touch = useDensity() === "touch";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const rows = useMemo(() => filterItems(items, query).slice(0, MAX_ROWS), [items, query]);
  useEffect(() => setSelected(0), [query]);
  const at = Math.min(selected, Math.max(0, rows.length - 1));

  const pick = (row: FindItem | undefined) => {
    if (!row) return;
    onClose();
    onPick(row);
  };

  // Capture phase, so the palette's keys win over the focused input and the view underneath.
  const latest = useRef({ rows, at, pick, onClose });
  latest.current = { rows, at, pick, onClose };
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const { rows: list, at: i, pick: go, onClose: close } = latest.current;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        take();
        if (list.length) setSelected((i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length);
      } else if (e.key === "Enter" && !e.isComposing) {
        take();
        go(list[i]);
      } else if (e.key === "Escape") {
        take();
        close();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // The shortcut that opened it closes it again.
        take();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Keep the selected row in view as the arrows walk past the fold.
  const rowNodes = useRef(new Map<number, unknown>());
  useEffect(() => {
    const node = rowNodes.current.get(at) as { scrollIntoView?: (o: { block: string }) => void } | undefined;
    node?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const panel = (
    <View style={styles.layer}>
      <Pressable style={styles.scrim} onPress={onClose} aria-label="Close" />
      <View style={[styles.panel, paletteEnter]}>
        <View style={styles.inputRow}>
          <Icon name="search" size={icon.lg} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            // Native has no key listener above; the keyboard's return key runs the selection.
            onSubmitEditing={() => pick(rows[at])}
            placeholder={placeholder}
            placeholderTextColor={colors.textQuaternary}
            autoFocus
            autoCapitalize="none"
            style={styles.input}
          />
        </View>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {rows.map((r, i) => (
            <View key={r.key}>
              {i === 0 || rows[i - 1].section !== r.section ? (
                <Text variant="mono" tone="quaternary" style={styles.section} numberOfLines={1}>
                  {r.section.toLowerCase()}
                </Text>
              ) : null}
              <View
                ref={(node: unknown) => {
                  if (node) rowNodes.current.set(i, node);
                  else rowNodes.current.delete(i);
                }}
                onPointerMove={() => {
                  if (at !== i) setSelected(i);
                }}
              >
                <ListRow
                  title={r.title}
                  trailing={r.trailing}
                  selected={i === at}
                  icon={<Icon name={r.icon} size={icon.sm} color={i === at ? colors.textAccent : (r.iconColor ?? colors.textQuaternary)} />}
                  onPress={() => pick(r)}
                />
              </View>
            </View>
          ))}
          {rows.length === 0 ? (
            <Text variant="caption" tone="tertiary" style={styles.empty}>
              {emptyText}
            </Text>
          ) : null}
        </ScrollView>
        {Platform.OS === "web" && !touch ? (
          <View style={styles.footer}>
            <Hint keys="↑↓" label="move" />
            <Hint keys="⏎" label="go to" />
            <View style={{ flex: 1 }} />
            <Hint keys="esc" label="close" />
          </View>
        ) : null}
      </View>
    </View>
  );

  if (Platform.OS === "web") return <Overlay>{panel}</Overlay>;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {panel}
    </Modal>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <View style={styles.hint}>
      <Kbd>{keys}</Kbd>
      <Text variant="mono" tone="quaternary">
        {label}
      </Text>
    </View>
  );
}

const web = Platform.OS === "web";

// The agenda palette's metrics (AgendaPalette.tsx), so the two read as one family.
const styles = StyleSheet.create({
  // Portaled to document.body on web, so `fixed` pins it to the viewport above every pane.
  layer: { position: (web ? "fixed" : "absolute") as "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", zIndex: 1000 },
  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  panel: {
    width: 520,
    maxWidth: "92%",
    maxHeight: (web ? "72vh" : "72%") as unknown as number,
    marginTop: (web ? "14vh" : 72) as unknown as number,
    overflow: "hidden",
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    ...shadow.lg,
  },
  inputRow: { flexDirection: "row", alignItems: "center", gap: space.md, height: 44, paddingHorizontal: space.lg, flexShrink: 0 },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    height: 44,
    color: colors.textPrimary,
    fontFamily: font.sans,
    fontSize: font.size.lg,
    ...(web ? ({ outlineStyle: "none" } as Record<string, unknown>) : null),
  },
  list: { maxHeight: 340, flexShrink: 1, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  listContent: { padding: space.sm, gap: 1 },
  section: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: space.xs },
  empty: { paddingHorizontal: space.sm, paddingVertical: space.lg },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    paddingHorizontal: space.lg,
    height: 32,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    flexShrink: 0,
  },
  hint: { flexDirection: "row", alignItems: "center", gap: space.xs },
});
