// Global shortcuts: OS-wide key bindings the desktop shell registers with the window
// manager (quick capture today). Only a desktop shell can own these — a browser tab can't
// claim a system-wide hotkey, and mobile has no notion of one — so the shell injects a
// store and everywhere else this module reports "nothing configurable" and the Shortcuts
// settings section hides itself.

export type ShortcutId = "capture";

/** One configurable binding, as the shell reports it. Accelerators are in the desktop
 *  shell's syntax ("Option+Shift+Space"): modifiers then key, joined by "+". */
export interface ShortcutBinding {
  id: ShortcutId;
  /** The accelerator currently registered with the OS. */
  accelerator: string;
  /** This platform's built-in binding, offered as a reset. */
  defaultAccelerator: string;
}

/** The user-facing catalog. Kept here rather than in the shell so copy stays with the UI;
 *  the shell only owns the bindings themselves. */
export const SHORTCUTS: { id: ShortcutId; label: string; description: string }[] = [
  {
    id: "capture",
    label: "Quick capture",
    description: "Open the capture panel from any app, without bringing Companion forward",
  },
];

export interface ShortcutStore {
  list(): Promise<ShortcutBinding[]>;
  /** Rebind and persist, resolving to the saved binding. Rejects (leaving the previous
   *  binding registered) if the accelerator is malformed or the OS refuses it. */
  set(id: ShortcutId, accelerator: string): Promise<ShortcutBinding>;
}

let injectedStore: ShortcutStore | null = null;

/** Register the platform's shortcut store (called once by the desktop shell). */
export function setShortcutStore(store: ShortcutStore | null): void {
  injectedStore = store;
}

/** The shell's shortcut store, or null where global shortcuts don't exist (web, mobile). */
export function shortcutStore(): ShortcutStore | null {
  return injectedStore;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform || navigator.userAgent || "");
}

/** Build an accelerator from a keydown. Returns null for presses that can't be a global
 *  binding: a modifier on its own, a bare key with no modifier, or a key we can't name. */
export function acceleratorFromKeyEvent(e: {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const key = keyName(e.code, e.key);
  if (!key) return null;
  const mods: string[] = [];
  // Display/notation order: ⌃⌥⇧⌘, which is also how macOS writes them.
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Option");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Cmd");
  // A global shortcut with no modifier would swallow that key in every other app.
  if (mods.length === 0) return null;
  return [...mods, key].join("+");
}

/** The accelerator's key name, from the physical key. Deliberately keyed off `code`, not
 *  `key`: on macOS Option+N reports key "˜", so the printed character lies about which key
 *  was pressed. Returns null for modifier-only presses and keys we have no name for. */
function keyName(code: string, key: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    NumpadEnter: "Enter",
    Escape: "Escape",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "Page Up",
    PageDown: "Page Down",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  if (named[code]) return named[code];
  // Punctuation and anything else printable, but only when the character is plain ASCII —
  // an Option-modified glyph (´, ˚, …) would otherwise be recorded as the key.
  const c = key.charCodeAt(0);
  if (key.length === 1 && c > 32 && c < 127) return key.toUpperCase();
  return null;
}

/** An accelerator as a human reads it: ⌥⇧Space on macOS, Alt+Shift+Space elsewhere. */
export function formatAccelerator(accelerator: string, mac: boolean = isMacPlatform()): string {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => modifierLabel(m, mac));
  const keyLabel = key.length === 1 ? key.toUpperCase() : key;
  // macOS writes chords as unspaced symbols (⌥⇧Space); everywhere else keeps the pluses.
  return mac ? [...mods, keyLabel].join("") : [...mods, keyLabel].join("+");
}

function modifierLabel(modifier: string, mac: boolean): string {
  switch (modifier.toLowerCase()) {
    case "cmd":
    case "command":
    case "super":
      return mac ? "⌘" : "Win";
    case "cmdorctrl":
      return mac ? "⌘" : "Ctrl";
    case "ctrl":
    case "control":
      return mac ? "⌃" : "Ctrl";
    case "option":
    case "optionoralt":
    case "alt":
      return mac ? "⌥" : "Alt";
    case "shift":
      return mac ? "⇧" : "Shift";
    default:
      return modifier;
  }
}
