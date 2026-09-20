import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Input, Text, colors, radius, space, useDensity, type PressState } from "@companion/design-system";

// A small, dependency-free emoji picker for area and project icons (PLAN-areas.md §1). It is
// an inline panel rather than a floating popover, so it needs no overlay positioning and
// works unchanged on web, desktop and native. The grid is a curated set that suits "areas of
// your life" and projects; the field below accepts any emoji the keyboard can produce.
const EMOJI: string[] = [
  "🏠", "🏡", "🏢", "💼", "🗂️", "📁", "📌", "🎯", "🚀", "⭐",
  "💡", "🧠", "📚", "📖", "✏️", "📝", "🎓", "🔬", "🧪", "💻",
  "⌨️", "🛠️", "⚙️", "🔧", "🧰", "📈", "📊", "💰", "💳", "🏦",
  "❤️", "🌱", "🌿", "🌳", "🌸", "🌞", "🌙", "🔥", "💧", "⚡",
  "🏃", "🚴", "🏋️", "🧘", "🥗", "🍎", "☕", "🍳", "🛒", "🧹",
  "👪", "👶", "🐶", "🐱", "🎉", "🎁", "🎵", "🎨", "🎬", "📷",
  "✈️", "🚗", "🗺️", "🏖️", "⛰️", "🏕️", "🎮", "⚽", "🎲", "🧩",
  "🗓️", "⏰", "✅", "🔒", "📣", "✉️", "📞", "🤝", "🧭", "🏆",
];

/** Keeps only the first grapheme of what was typed, so an icon is always one emoji. */
function firstGrapheme(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) {
    for (const s of new Segmenter(undefined, { granularity: "grapheme" }).segment(t)) return s.segment;
  }
  return Array.from(t)[0] ?? "";
}

export function EmojiPicker({
  value,
  onPick,
  onRemove,
  onClose,
}: {
  value?: string | null;
  onPick: (emoji: string) => void;
  /** Shown only when there is an icon to remove. */
  onRemove?: () => void;
  onClose: () => void;
}) {
  const touch = useDensity() === "touch";
  const [custom, setCustom] = useState("");
  const cell = touch ? 40 : 28;
  const submitCustom = () => {
    const emoji = firstGrapheme(custom);
    setCustom("");
    if (emoji) onPick(emoji);
  };
  return (
    <View style={styles.panel}>
      <View style={styles.grid}>
        {EMOJI.map((e) => (
          <Pressable
            key={e}
            onPress={() => onPick(e)}
            aria-label={`Use ${e} as the icon`}
            style={({ hovered, pressed }: PressState) => [
              styles.cell,
              { width: cell, height: cell },
              e === value ? styles.cellOn : { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
            ]}
          >
            <Text style={{ fontSize: touch ? 22 : 16, lineHeight: touch ? 28 : 20 }}>{e}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.footer}>
        <View style={{ flex: 1 }}>
          <Input size="sm" placeholder="Or type any emoji, then Enter" value={custom} onChangeText={setCustom} onSubmitEditing={submitCustom} />
        </View>
        {value && onRemove ? <Button label="Remove" variant="ghost" size="sm" onPress={onRemove} /> : null}
        <Button label="Done" variant="secondary" size="sm" onPress={onClose} />
      </View>
    </View>
  );
}

const styles = {
  panel: {
    alignSelf: "flex-start" as const,
    maxWidth: 360,
    padding: space.sm,
    gap: space.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 2 },
  cell: { alignItems: "center" as const, justifyContent: "center" as const, borderRadius: radius.sm },
  cellOn: { backgroundColor: colors.accentSoft },
  footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs },
};
