import type { GestureResponderEvent, ViewStyle } from "react-native";

// Wails v3 window-drag hints. Applying `--wails-draggable: drag` to an element makes
// it a window drag handle on desktop; `no-drag` opts an interactive child back out.
// The property inherits, so a draggable container + no-drag controls is all it takes.
// On web these are unknown CSS custom properties and are simply ignored; on native
// they're not real ViewStyle keys, hence the cast — they no-op there too.
export const dragRegion = { "--wails-draggable": "drag" } as unknown as ViewStyle;
export const noDragRegion = { "--wails-draggable": "no-drag" } as unknown as ViewStyle;

// Pressable's callback state. react-native-web adds `hovered`; real react-native
// omits it (so it's optional here). Annotate Pressable style/children callbacks with
// this to read `hovered` on web/desktop without breaking the native types.
export type PressState = { pressed: boolean; hovered?: boolean };

// True when a press was a Cmd-click (macOS) or Ctrl-click (elsewhere) — the conventional
// "open in a new tab" modifier. On native there are no modifier keys, so it's always false.
export function opensInNewTab(e?: GestureResponderEvent): boolean {
  const n = e?.nativeEvent as { metaKey?: boolean; ctrlKey?: boolean } | undefined;
  return Boolean(n?.metaKey || n?.ctrlKey);
}

// A CSS transition, animated by react-native-web on web/desktop and ignored on native.
// These aren't real ViewStyle keys, hence the cast. Use as its own style-array element.
export function transition(
  property: string,
  durationMs = 200,
  timingFunction = "cubic-bezier(0.2, 0, 0, 1)",
): ViewStyle {
  return {
    transitionProperty: property,
    transitionDuration: `${durationMs}ms`,
    transitionTimingFunction: timingFunction,
  } as unknown as ViewStyle;
}
