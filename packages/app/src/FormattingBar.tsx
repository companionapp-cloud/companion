import { Platform, View } from "react-native";
import { Icon, IconButton, colors, space } from "@companion/design-system";
import type { IconName } from "@companion/design-system";
import type { EditorController, FormatName, FormatState } from "@companion/editor";
import type { RefObject } from "react";

// The formatting actions shown in the web selection bar, in order (mirrors the native
// keyboard toolbar in @companion/editor). Insert-reference is prepended separately.
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

/** Web/desktop: a floating bar of insert + formatting actions anchored to the bottom of the
 * editor, shown while the editor is focused. Drives the editor through its imperative handle.
 * `state` may be null before the first format snapshot arrives (buttons render enabled).
 * Native manages its own keyboard-anchored toolbar, so this is web-only chrome. */
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
  return (
    <View style={styles.formatBar} pointerEvents="box-none">
      <View style={styles.formatBarInner}>
        <IconButton label="Insert reference" size="sm" onPress={() => editorRef.current?.insertReference()}>
          <Icon name="link" size={17} color={colors.textSecondary} />
        </IconButton>
        <IconButton label="Insert table" size="sm" onPress={() => editorRef.current?.insertTable()}>
          <Icon name="table" size={17} color={colors.textSecondary} />
        </IconButton>
        {canAttach ? (
          <IconButton label="Attach file" size="sm" onPress={() => editorRef.current?.insertDocument()}>
            <Icon name="file" size={17} color={colors.textSecondary} />
          </IconButton>
        ) : null}
        <View style={styles.formatBarDivider} />
        {FORMAT_BUTTONS.map((b) => {
          const active = !!state?.active[b.name];
          const disabled = state ? !state.enabled[b.name] : false;
          return (
            <IconButton
              key={b.name}
              label={b.label}
              size="sm"
              active={active}
              disabled={disabled}
              onPress={() => editorRef.current?.format(b.name)}
            >
              <Icon name={b.icon} size={17} color={active ? colors.accentHover : colors.textSecondary} />
            </IconButton>
          );
        })}
      </View>
    </View>
  );
}

const styles = {
  // Floating formatting bar, centered along the bottom of the editor (web/desktop).
  formatBar: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: space.lg,
    alignItems: "center" as const,
  },
  formatBarInner: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    borderRadius: 12,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    // A soft lift so it reads as floating above the document (web only).
    ...(Platform.OS === "web" ? { boxShadow: "0 6px 22px rgba(0,0,0,0.13)" } : null),
  },
  formatBarDivider: {
    width: 1,
    height: 20,
    marginHorizontal: space.xs,
    backgroundColor: colors.borderSubtle,
  },
};
