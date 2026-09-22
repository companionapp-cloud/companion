import { useState } from "react";
import { Image, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { Icon, Text, colors, font, radius, space } from "@companion/design-system";
import type { PressState } from "@companion/design-system";
import type { Notebook } from "./host";
import { coverHex } from "./paper";

// SPIKE (PLAN-notebooks.md §2): the notebooks tool's home. No split view: notebooks are shown
// as journals, one to a row on a phone and two or three across on wider windows. Plain React
// Native, so the same shelf serves web, desktop and the native app.

const COVER_RATIO = 4 / 3;
const COVER_MAX = 260;

/** Columns by window width: a list on phones, then two and three across. */
export function shelfColumns(width: number): 1 | 2 | 3 {
  if (width < 640) return 1;
  if (width < 1100) return 2;
  return 3;
}

export function NotebookCoverArt({ notebook, width, imageUrl }: { notebook: Notebook; width: number; imageUrl?: string | null }) {
  const height = Math.round(width * COVER_RATIO);
  const hex = coverHex(notebook.cover.color);
  const spine = Math.max(10, Math.round(width * 0.07));
  return (
    <View style={[styles.cover, { width, height, backgroundColor: hex }]}>
      {imageUrl ? <Image source={{ uri: imageUrl }} resizeMode="cover" style={styles.fill} /> : null}
      {/* The spine: a darker band with a crease, over colour and image alike. */}
      <View style={[styles.spine, { width: spine }]} />
      <View style={[styles.crease, { left: spine }]} />
      {/* The elastic band. */}
      <View style={[styles.band, { right: Math.round(width * 0.09) }]} />
      <View style={[styles.plate, { left: spine + Math.round(width * 0.1), right: Math.round(width * 0.2), top: Math.round(height * 0.16) }]}>
        <Text numberOfLines={2} style={styles.plateTitle}>
          {notebook.title || "Untitled"}
        </Text>
        <Text variant="mono" style={styles.plateMeta}>
          {notebook.pageCount} {notebook.pageCount === 1 ? "page" : "pages"}
        </Text>
      </View>
    </View>
  );
}

export function NotebookShelf({
  notebooks,
  coverUrls,
  onOpen,
  onCreate,
  onEdit,
}: {
  notebooks: Notebook[];
  /** Resolved cover images by notebook id. */
  coverUrls: Record<string, string | null>;
  onOpen(id: string): void;
  onCreate(): void;
  onEdit(id: string): void;
}) {
  const { width } = useWindowDimensions();
  const columns = shelfColumns(width);
  const gap = columns === 1 ? space.xxl : space.huge;
  const pad = columns === 1 ? space.xl2 : space.huge;
  const cell = Math.min(COVER_MAX, Math.floor((width - pad * 2 - gap * (columns - 1)) / columns));
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surfaceApp }} contentContainerStyle={{ padding: pad, alignItems: "center" }}>
      <View style={[styles.grid, { gap, width: cell * columns + gap * (columns - 1) }]}>
        {notebooks.map((n) => (
          <Pressable
            key={n.id}
            aria-label={`Open ${n.title || "Untitled"}`}
            onPress={() => onOpen(n.id)}
            onHoverIn={() => setHovered(n.id)}
            onHoverOut={() => setHovered((h) => (h === n.id ? null : h))}
            style={({ pressed }: PressState) => [{ width: cell, transform: [{ translateY: pressed ? 0 : hovered === n.id ? -3 : 0 }] }]}
          >
            <NotebookCoverArt notebook={n} width={cell} imageUrl={coverUrls[n.id]} />
            <View style={styles.caption}>
              <Text numberOfLines={1} style={{ flex: 1 }}>
                {n.title || "Untitled"}
              </Text>
              <Pressable aria-label="Edit cover" hitSlop={8} onPress={() => onEdit(n.id)}>
                <Icon name="moreH" size={14} color={colors.textTertiary} />
              </Pressable>
            </View>
          </Pressable>
        ))}
        <Pressable
          aria-label="New notebook"
          onPress={onCreate}
          style={({ hovered: h }: PressState) => [
            styles.create,
            { width: cell, height: Math.round(cell * COVER_RATIO), backgroundColor: h ? colors.surfaceHover : "transparent" },
          ]}
        >
          <Icon name="plus" size={20} color={colors.textTertiary} />
          <Text tone="tertiary">New notebook</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = {
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const },
  cover: {
    overflow: "hidden" as const,
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
    borderTopRightRadius: 12,
    borderBottomRightRadius: 12,
    shadowColor: "#111110",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 18,
    elevation: 6,
  },
  fill: { position: "absolute" as const, left: 0, top: 0, right: 0, bottom: 0, width: "100%" as const, height: "100%" as const },
  spine: { position: "absolute" as const, left: 0, top: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.22)" },
  crease: { position: "absolute" as const, top: 0, bottom: 0, width: 2, backgroundColor: "rgba(255,255,255,0.14)" },
  band: { position: "absolute" as const, top: 0, bottom: 0, width: 9, backgroundColor: "rgba(0,0,0,0.38)" },
  plate: {
    position: "absolute" as const,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: radius.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.ml,
    gap: space.xxs,
  },
  plateTitle: { fontFamily: font.sans, fontSize: font.size.base, fontWeight: font.weight.semibold, color: "#1a1a18" },
  plateMeta: { fontSize: font.size["2xs"], color: "#7b7b75" },
  caption: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, marginTop: space.lg, paddingHorizontal: space.xxs },
  create: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: space.md,
    borderWidth: 1,
    borderStyle: "dashed" as const,
    borderColor: colors.borderDefault,
    borderRadius: 12,
  },
};
