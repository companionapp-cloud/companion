import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import { Platform, View } from "react-native";
import { Divider, Icon, IconButton, Text, colors, layout, row, space, useDensity } from "@companion/design-system";
import type { IconName } from "@companion/design-system";
import type { EditorController, FormatName, FormatState } from "@companion/editor";

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
 * the host renders it as the last row of a column, below the scrolling document; on a phone
 * the web shell keeps that column above the keyboard (apps/web/src/viewportFit.ts). Drives the
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
  // On the web a View's ref is its DOM node.
  const barRef = useRef<unknown>(null);
  useTapsKeepFocus(barRef, touch);

  // On touch every control gets an equal share of the row, and the whole share is its target.
  const cell = (key: string, control: ReactElement) =>
    touch ? (
      <View key={key} style={styles.cell}>
        {control}
      </View>
    ) : (
      control
    );

  const buttons = (
    <>
      {FORMAT_BUTTONS.map((b) => {
        const active = !!state?.active[b.name];
        const disabled = state ? !state.enabled[b.name] : false;
        return cell(
          b.name,
          <IconButton
            key={b.name}
            label={b.label}
            size={size}
            active={active}
            disabled={disabled}
            onPress={() => editorRef.current?.format(b.name)}
          >
            <Icon name={b.icon} size={glyph} color={active ? colors.textAccent : colors.textSecondary} />
          </IconButton>,
        );
      })}
      <Divider vertical style={styles.divider} />
      {cell(
        "table",
        <IconButton label="Insert table" size={size} onPress={() => editorRef.current?.insertTable()}>
          <Icon name="table" size={glyph} color={colors.textSecondary} />
        </IconButton>,
      )}
      {canAttach
        ? cell(
            "attach",
            <IconButton label="Attach image or file" size={size} onPress={() => editorRef.current?.insertDocument()}>
              <Icon name="image" size={glyph} color={colors.textSecondary} />
            </IconButton>,
          )
        : null}
      {cell(
        "reference",
        <IconButton label="Insert reference" size={size} onPress={() => editorRef.current?.insertReference()}>
          <Icon name="link" size={glyph} color={colors.textSecondary} />
        </IconButton>,
      )}
    </>
  );

  // Touch: the row fits a phone's width rather than scrolling sideways; a scroll would need the
  // touches the bar keeps to itself (useTapsKeepFocus).
  if (touch) {
    return (
      <View ref={barRef as never} style={[styles.bar, styles.barTouch]}>
        {buttons}
      </View>
    );
  }

  return (
    <View ref={barRef as never} style={[styles.bar, styles.barPointer]}>
      {buttons}
      <View style={{ flex: 1 }} />
      <Text variant="mono" tone="quaternary" numberOfLines={1}>
        markdown · ⌘B ⌘I ⌘K
      </Text>
    </View>
  );
}

/** A press on the bar must never take focus from the document. On iOS an editor that loses focus
 *  takes the keyboard down with it, and the action's refocus brings it back up, so every toggle
 *  bounced the keyboard and the page with it. A mouse is simple: cancel mousedown. A touch on iOS
 *  blurs the editor however mousedown or pointerdown are handled (as of iOS 27), so the bar
 *  cancels touchstart, which keeps the browser from treating the touch as a tap at all, and
 *  presses the control itself when the finger lifts where it went down. */
function useTapsKeepFocus(ref: RefObject<unknown>, touch: boolean) {
  useEffect(() => {
    const bar = ref.current as HTMLElement | null;
    if (Platform.OS !== "web" || typeof bar?.addEventListener !== "function") return;

    // The control under a point: a pressable (react-native-web gives them a tabindex) or, from
    // anywhere in a touch cell, the one it holds.
    const controlAt = (node: EventTarget | null): HTMLElement | null => {
      let el = node instanceof Element ? node : null;
      while (el && el.parentElement !== bar) el = el.parentElement;
      if (!el) return null;
      return el.matches("[tabindex]") ? (el as HTMLElement) : el.querySelector<HTMLElement>("[tabindex]");
    };

    let pressed: HTMLElement | null = null;
    let startX = 0;
    let startY = 0;
    const onMouseDown = (e: MouseEvent) => e.preventDefault();
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        pressed = null;
        return;
      }
      e.preventDefault();
      pressed = controlAt(e.target);
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const control = pressed;
      pressed = null;
      const touch = e.changedTouches[0];
      if (!control || !touch || Math.hypot(touch.clientX - startX, touch.clientY - startY) > 12) return;
      if (controlAt(document.elementFromPoint(touch.clientX, touch.clientY)) === control) control.click();
    };
    const onTouchCancel = () => {
      pressed = null;
    };

    bar.addEventListener("mousedown", onMouseDown);
    bar.addEventListener("touchstart", onTouchStart, { passive: false });
    bar.addEventListener("touchend", onTouchEnd);
    bar.addEventListener("touchcancel", onTouchCancel);
    return () => {
      bar.removeEventListener("mousedown", onMouseDown);
      bar.removeEventListener("touchstart", onTouchStart);
      bar.removeEventListener("touchend", onTouchEnd);
      bar.removeEventListener("touchcancel", onTouchCancel);
    };
    // Density picks a different layout for the bar, so follow its node when that flips.
  }, [ref, touch]);
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
  barTouch: { height: row.touch, paddingHorizontal: space.xs, backgroundColor: colors.surfaceCard },
  // An equal share of the touch row, full height: 11 controls still leave each ~31px at 375px.
  cell: { flex: 1, alignSelf: "stretch" as const, alignItems: "center" as const, justifyContent: "center" as const },
  divider: { alignSelf: "center" as const, height: 12, marginHorizontal: space.xs },
};
