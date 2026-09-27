import { useEffect, useRef, useState } from "react";
import { Animated, Image, Platform, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { Icon, Text, colors, font, radius, space } from "@companion/design-system";
import type { PressState } from "@companion/design-system";
import type { Notebook } from "./host";
import { coverHex } from "./paper";
import { countLabel } from "./mediums";
import { mediumCover, peekCover } from "./mediumCovers";

// SPIKE (PLAN-notebooks.md §2): the notebooks tool's home. No split view: notebooks are shown
// as journals, one to a row on a phone and two or three across on wider windows. Plain React
// Native, so the same shelf serves web, desktop and the native app. Paper notebooks are
// journals; the ancient mediums (PLAN §11) sit on the shelf as what they are: a clay tablet on
// its archive pile, a bound wax codex, a heap of sherds.

const COVER_RATIO = 4 / 3;
const COVER_MAX = 260;

/** Columns by window width: a list on phones, then two and three across. */
export function shelfColumns(width: number): 1 | 2 | 3 {
  if (width < 640) return 1;
  if (width < 1100) return 2;
  return 3;
}

/** The shader-rendered cover of a clay, wax or pottery notebook (mediumCovers.ts), once it's
 *  ready; null meanwhile, and always on native, where the plain art stands in. */
function useMediumCover(notebook: Notebook, width: number): string | null {
  const { id, title, medium, leaves, pageCount } = notebook;
  const subject = { id, title, medium, leaves, pageCount };
  const [url, setUrl] = useState<string | null>(() => peekCover(subject, width));
  useEffect(() => {
    let live = true;
    void mediumCover({ id, title, medium, leaves, pageCount }, width).then((u) => {
      if (live && u) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [id, title, medium, leaves, pageCount, width]);
  return medium === "paper" ? null : url;
}

/** Where covers are rendered (a DOM): there the shelf waits for the real cover rather than
 *  flashing the plain art first. */
const RENDERS_COVERS = typeof document !== "undefined";

/** A rendered cover, fading in when it wasn't ready at first paint. */
function CoverImage({ uri, width, height }: { uri: string; width: number; height: number }) {
  const ready = useRef(peekedAtMount(uri)).current;
  const opacity = useRef(new Animated.Value(ready ? 1 : 0)).current;
  useEffect(() => {
    if (!ready) Animated.spring(opacity, { toValue: 1, useNativeDriver: false, bounciness: 0, speed: 14 }).start();
  }, [ready, opacity]);
  return (
    <Animated.View style={{ width, height, opacity }}>
      <Image source={{ uri }} style={{ width, height }} resizeMode="contain" />
    </Animated.View>
  );
}

// Covers seen by a CoverImage before: those show at once (a remount, a resize), the rest fade.
const shown = new Set<string>();
function peekedAtMount(uri: string): boolean {
  const seen = shown.has(uri);
  shown.add(uri);
  return seen;
}

export function NotebookCoverArt({ notebook, width, imageUrl }: { notebook: Notebook; width: number; imageUrl?: string | null }) {
  const cover = useMediumCover(notebook, width);
  if (cover) return <CoverImage uri={cover} width={width} height={Math.round(width * COVER_RATIO)} />;
  // On web the real cover is on its way (usually from the kept covers, in a moment): hold its
  // space empty rather than flash the plain art.
  if (RENDERS_COVERS && notebook.medium !== "paper") return <View style={{ width, height: Math.round(width * COVER_RATIO) }} />;
  if (notebook.medium === "clay") return <ClayArt notebook={notebook} width={width} />;
  if (notebook.medium === "wax") return <WaxArt notebook={notebook} width={width} />;
  if (notebook.medium === "sherd") return <SherdArt notebook={notebook} width={width} />;
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
      <View
        style={[
          styles.plate,
          width < TINY ? { display: "none" } : null,
          { left: spine + Math.round(width * 0.1), right: Math.round(width * 0.2), top: Math.round(height * 0.16) },
        ]}
      >
        <Text numberOfLines={2} style={styles.plateTitle}>
          {notebook.title || "Untitled"}
        </Text>
        <Text variant="mono" style={styles.plateMeta}>
          {countLabel("paper", notebook.pageCount)}
        </Text>
      </View>
    </View>
  );
}

const SERIF = Platform.select({ web: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif", default: "Georgia" });

/** A few deterministic numbers from an id, so every device draws the same marks. */
function marks(id: string, n: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out.push(((h >>> 0) % 1000) / 1000);
  }
  return out;
}

/** A clay tablet, a second one behind it, with rows of pressed wedges and the title. */
/** Under this width (the medium picker's previews) the art drops its lettering. */
const TINY = 100;

function ClayArt({ notebook, width }: { notebook: Notebook; width: number }) {
  const height = Math.round(width * COVER_RATIO);
  const w = Math.round(width * 0.8);
  const h = Math.round(height * 0.84);
  const r = marks(notebook.id, 40);
  const radius = Math.round(w * 0.13);
  const row = Math.max(8, Math.round(h * 0.075));
  return (
    <View style={{ width, height }}>
      <View
        style={[
          styles.clay,
          { width: w, height: h, borderRadius: radius, left: width - w - 2, top: 0, backgroundColor: "#a4553a", transform: [{ rotate: "4deg" }] },
        ]}
      />
      <View style={[styles.clay, { width: w, height: h, borderRadius: radius, left: 2, top: height - h - 4 }]}>
        <View style={{ position: "absolute", left: w * 0.12, right: w * 0.12, top: h * 0.36, gap: row * 0.55 }}>
          {[0, 1, 2, 3, 4, 5].map((line) => (
            <View key={line} style={{ flexDirection: "row", gap: 4, height: row * 0.45, borderBottomWidth: 1, borderBottomColor: "rgba(70,24,12,0.3)" }}>
              {r.slice(line * 6, line * 6 + 6).map((v, i) => (
                <View
                  key={i}
                  style={{ width: 4 + v * row * 0.9, height: 3, marginTop: 2 + ((v * 7) % 3), borderRadius: 1, backgroundColor: "rgba(70,24,12,0.45)" }}
                />
              ))}
            </View>
          ))}
        </View>
        <View style={{ position: "absolute", left: w * 0.12, right: w * 0.12, top: h * 0.1, display: width < TINY ? "none" : "flex" }}>
          <Text
            numberOfLines={2}
            style={[
              styles.artTitle,
              { color: "rgba(70,24,12,0.9)", textShadowColor: "rgba(255,200,170,0.45)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 0 },
            ]}
          >
            {notebook.title || "Untitled"}
          </Text>
          <Text style={[styles.artMeta, { color: "rgba(70,24,12,0.7)" }]}>{countLabel("clay", notebook.pageCount)}</Text>
        </View>
      </View>
    </View>
  );
}

/** A closed wax codex: a wooden frame round dark wax, cord holes at the spine, and one edge
 *  per bound leaf showing beneath. */
function WaxArt({ notebook, width }: { notebook: Notebook; width: number }) {
  const height = Math.round(width * COVER_RATIO);
  const leaves = Math.min(notebook.leaves ?? notebook.pageCount, 8);
  const edge = Math.max(2, Math.round(width * 0.012));
  const frame = Math.round(width * 0.07);
  const inset = (leaves - 1) * edge;
  return (
    <View style={{ width, height }}>
      {Array.from({ length: leaves - 1 }, (_, i) => (
        <View
          key={i}
          style={[
            styles.waxLeaf,
            {
              left: (leaves - 1 - i) * edge,
              top: (leaves - 1 - i) * edge,
              width: width - inset,
              height: height - inset,
              backgroundColor: i % 2 ? "#6e4526" : "#80532f",
            },
          ]}
        />
      ))}
      <View style={[styles.waxLeaf, styles.waxTop, { left: 0, top: 0, width: width - inset, height: height - inset, padding: frame }]}>
        <View style={styles.wax}>
          {width < TINY ? null : (
            <>
              <Text
                numberOfLines={3}
                style={[
                  styles.artTitle,
                  { color: "#6b4212", textShadowColor: "rgba(255,240,200,0.7)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 0 },
                ]}
              >
                {notebook.title || "Untitled"}
              </Text>
              <Text style={[styles.artMeta, { color: "rgba(107,66,18,0.65)" }]}>{countLabel("wax", notebook.pageCount)}</Text>
            </>
          )}
        </View>
        <View style={[styles.hole, { left: frame * 0.3, top: "30%" }]} />
        <View style={[styles.hole, { left: frame * 0.3, top: "66%" }]} />
      </View>
    </View>
  );
}

/** A heap of potsherds, the top one inked with the title. */
function SherdArt({ notebook, width }: { notebook: Notebook; width: number }) {
  const height = Math.round(width * COVER_RATIO);
  const r = marks(notebook.id, 16);
  const shard = (i: number, w: number, h: number, left: number, top: number, color: string) => ({
    position: "absolute" as const,
    width: w,
    height: h,
    left,
    top,
    backgroundColor: color,
    borderTopLeftRadius: 6 + r[i] * w * 0.4,
    borderTopRightRadius: 3 + r[i + 1] * w * 0.15,
    borderBottomRightRadius: 8 + r[i + 2] * w * 0.45,
    borderBottomLeftRadius: 2 + r[i + 3] * w * 0.1,
    transform: [{ rotate: `${Math.round((r[i + 4] - 0.5) * 50)}deg` }],
    shadowColor: "#2a1408",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
  });
  const topW = width * 0.82;
  const topH = height * 0.5;
  return (
    <View style={{ width, height }}>
      <View style={shard(0, width * 0.55, height * 0.34, width * 0.02, height * 0.08, "#1d1614")} />
      <View style={shard(5, width * 0.5, height * 0.3, width * 0.46, height * 0.66, "#d8c4a0")} />
      <View style={shard(9, width * 0.42, height * 0.26, width * 0.04, height * 0.72, "#5d7a34")} />
      <View
        style={[
          shard(2, topW, topH, width * 0.09, height * 0.26, "#c27a4f"),
          { transform: [{ rotate: `${Math.round((r[12] - 0.5) * 10)}deg` }], justifyContent: "center", paddingHorizontal: topW * 0.14 },
        ]}
      >
        {width < TINY ? null : (
          <>
            <Text numberOfLines={2} style={[styles.artTitle, { color: "#1f1510", fontStyle: "italic" }]}>
              {notebook.title || "Untitled"}
            </Text>
            <Text style={[styles.artMeta, { color: "rgba(31,21,16,0.65)", fontStyle: "italic" }]}>{countLabel("sherd", notebook.pageCount)}</Text>
          </>
        )}
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
              <Text variant="mono" tone="quaternary">
                {countLabel(n.medium, n.pageCount)}
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
  clay: {
    position: "absolute" as const,
    backgroundColor: "#b3603f",
    shadowColor: "#2a1408",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    borderTopWidth: 2,
    borderTopColor: "rgba(255,238,214,0.45)",
    borderBottomWidth: 3,
    borderBottomColor: "rgba(84,50,22,0.3)",
  },
  artTitle: { fontFamily: SERIF, fontSize: font.size.lg, fontWeight: font.weight.semibold, lineHeight: 22 },
  artMeta: { fontFamily: SERIF, fontSize: font.size.xs, marginTop: 4, letterSpacing: 0.6 },
  waxLeaf: { position: "absolute" as const, borderRadius: 5, borderWidth: 1, borderColor: "rgba(0,0,0,0.35)" },
  waxTop: { backgroundColor: "#7d512d", shadowColor: "#1e1208", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 16 },
  wax: {
    flex: 1,
    backgroundColor: "#e8bd62",
    borderRadius: 2,
    padding: space.lg,
    justifyContent: "center" as const,
    borderTopWidth: 3,
    borderTopColor: "rgba(0,0,0,0.5)",
  },
  hole: { position: "absolute" as const, width: 6, height: 6, borderRadius: 3, backgroundColor: "#140c06" },
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
