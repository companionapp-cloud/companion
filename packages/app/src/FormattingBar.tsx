import { ScrollView, View } from "react-native";
import { Divider, Icon, IconButton, Text, colors, layout, row, space, useDensity } from "@companion/design-system";
import type { IconName } from "@companion/design-system";
import type { EditorController, FormatName, FormatState } from "@companion/editor";
import type { RefObject } from "react";

// The formatting toggles, in order (mirrors the native keyboard toolbar in
// @companion/editor). The insert actions — table, file, reference — follow them.
const FORMAT_BUTTONS: { name: FormatName; icon: IconName; label: string }[] = [
  { name: "bold", icon: "bold", label: "Bold" },
  { name: "italic", icon: "italic", label: "Italic" },
  { name: "strike", icon: "strikethrough", label: "Strikethrough" },
  { name: "code", icon: "code", label: "Code" },
  { name: "codeBlock", icon: "codeBlock", label: "Code block" },
  { name: "blockquote", icon: "quote", label: "Blockquote" },
  { name: "bulletList", icon: "listBullet", label: "Bulleted list" },
  { name: "orderedList", icon: "listOrdered", label: "Numbered list" },
];

/** Web/desktop: the formatting bar pinned under the document — a 28px strip with a top
 * hairline (44px with touch-sized buttons on touch density). It is a normal flex child, so
 * the host renders it as the last row of a column, below the scrolling document. Drives the
 * editor through its imperative handle. `state` may be null before the first format snapshot
 * arrives (buttons render enabled). Native manages its own keyboard-anchored toolbar, so
 * this is web-only chrome. */
export function FormattingBar({
  state,
  editorRef,
  canAttach,
}: {
  state: FormatState | null;
  editorRef: RefObject<EditorController | null>;
  /** Show the file-embed action (PLAN §6.9) — only when a documentSource is wired. */
  canAttach: boolean;
}) {
  const touch = useDensity() === "touch";
  const size = touch ? "lg" : "sm";
  const glyph = touch ? 17 : 13;

  const buttons = (
    <>
      {FORMAT_BUTTONS.map((b) => {
        const active = !!state?.active[b.name];
        const disabled = state ? !state.enabled[b.name] : false;
        return (
          <IconButton
            key={b.name}
            label={b.label}
            size={size}
            active={active}
            disabled={disabled}
            onPress={() => editorRef.current?.format(b.name)}
          >
            <Icon name={b.icon} size={glyph} color={active ? colors.textAccent : colors.textSecondary} />
          </IconButton>
        );
      })}
      <Divider vertical style={styles.divider} />
      <IconButton label="Insert table" size={size} onPress={() => editorRef.current?.insertTable()}>
        <Icon name="table" size={glyph} color={colors.textSecondary} />
      </IconButton>
      {canAttach ? (
        <IconButton label="Attach image or file" size={size} onPress={() => editorRef.current?.insertDocument()}>
          <Icon name="image" size={glyph} color={colors.textSecondary} />
        </IconButton>
      ) : null}
      <IconButton label="Insert reference" size={size} onPress={() => editorRef.current?.insertReference()}>
        <Icon name="link" size={glyph} color={colors.textSecondary} />
      </IconButton>
    </>
  );

  // Touch: the row outgrows a phone's width, so it scrolls sideways.
  if (touch) {
    return (
      <View style={[styles.bar, styles.barTouch]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.touchContent}>
          {buttons}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.bar, styles.barPointer]}>
      {buttons}
      <View style={{ flex: 1 }} />
      <Text variant="mono" tone="quaternary" numberOfLines={1}>
        markdown · ⌘B ⌘I ⌘K
      </Text>
    </View>
  );
}

const styles = {
  bar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  barPointer: { height: layout.subToolbarH, gap: 1, paddingHorizontal: space.sm },
  barTouch: { height: row.touch, backgroundColor: colors.surfaceCard },
  touchContent: { alignItems: "center" as const, gap: space.xxs, paddingHorizontal: space.sm },
  divider: { alignSelf: "center" as const, height: 12, marginHorizontal: space.xs },
};
