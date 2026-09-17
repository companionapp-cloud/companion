import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Kbd, Text, colors, control, motion, radius, space, transition, type PressState } from "@companion/design-system";
import { SettingsNote } from "./settingsUi";
import {
  SHORTCUTS,
  acceleratorFromKeyEvent,
  formatAccelerator,
  shortcutStore,
  type ShortcutBinding,
  type ShortcutId,
} from "./shortcuts";

/** Settings › Shortcuts: rebind the desktop app's OS-wide shortcuts. Device-local (never
 *  synced) — a hotkey is a per-machine ergonomic choice, and the binding lives with the
 *  shell that registers it. The section only appears where a shell injected a shortcut
 *  store, i.e. the desktop app. */
export function ShortcutSettings() {
  const store = shortcutStore();
  const [bindings, setBindings] = useState<ShortcutBinding[] | null>(null);
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    store
      .list()
      .then((rows) => !cancelled && setBindings(rows))
      .catch(() => !cancelled && setError("Couldn’t read the current shortcuts."));
    return () => {
      cancelled = true;
    };
  }, [store]);

  const rebind = useCallback(
    async (id: ShortcutId, accelerator: string) => {
      if (!store) return;
      setRecording(null);
      setError(null);
      try {
        const saved = await store.set(id, accelerator);
        setBindings((rows) => (rows ?? []).map((b) => (b.id === saved.id ? saved : b)));
      } catch (e) {
        // The old binding is still registered — the shell rolls back on failure.
        setError(e instanceof Error ? e.message : "The system wouldn’t take that shortcut.");
      }
    },
    [store],
  );

  // While recording, swallow every keydown at the capture phase so the chord doesn't also
  // trigger the app underneath, and translate it into an accelerator. Esc cancels.
  useEffect(() => {
    if (!recording || typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(null);
        return;
      }
      const accelerator = acceleratorFromKeyEvent(e);
      if (!accelerator) return; // modifier held, or an unbindable key — keep listening
      void rebind(recording, accelerator);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, rebind]);

  if (!store) return null;

  return (
    <View style={styles.section}>
      <SettingsNote>
        Shortcuts work system-wide, so they win over whatever app you’re in — pick a chord no other app needs. This only
        applies to this device.
      </SettingsNote>
      <View style={styles.list}>
        {SHORTCUTS.map((s, i) => {
          const binding = bindings?.find((b) => b.id === s.id);
          const isRecording = recording === s.id;
          const isDefault = !!binding && binding.accelerator === binding.defaultAccelerator;
          return (
            <View key={s.id} style={[styles.row, i === SHORTCUTS.length - 1 ? null : styles.rowDivider]}>
              <View style={styles.rowBody}>
                <Text variant="label">{s.label}</Text>
                <Text variant="caption" tone="tertiary">
                  {s.description}
                </Text>
              </View>
              {binding && !isDefault ? (
                <Button label="Reset" variant="ghost" size="sm" onPress={() => void rebind(s.id, binding.defaultAccelerator)} />
              ) : null}
              <Pressable
                onPress={() => setRecording(isRecording ? null : s.id)}
                aria-label={isRecording ? `Press the new shortcut for ${s.label}` : `Change the ${s.label} shortcut`}
                style={({ hovered, pressed }: PressState) => [
                  styles.chord,
                  transition("background-color, border-color", motion.fast),
                  isRecording ? styles.chordRecording : pressed ? styles.chordPressed : hovered ? styles.chordHover : null,
                ]}
              >
                {isRecording ? (
                  <Text variant="mono" tone="accent">
                    press keys…
                  </Text>
                ) : binding ? (
                  <Kbd>{formatAccelerator(binding.accelerator)}</Kbd>
                ) : (
                  <Text variant="mono" tone="quaternary">
                    —
                  </Text>
                )}
              </Pressable>
            </View>
          );
        })}
      </View>
      {recording ? (
        <View style={styles.hint}>
          <SettingsNote>Hold a modifier</SettingsNote>
          <Kbd>⌥</Kbd>
          <Kbd>⌃</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>⌘</Kbd>
          <SettingsNote>and press a key.</SettingsNote>
          <Kbd>esc</Kbd>
          <SettingsNote>cancels.</SettingsNote>
        </View>
      ) : null}
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </View>
  );
}

const styles = {
  section: { gap: space.lg },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.ml,
    paddingVertical: space.md,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  // The chord is a button (press to record), so it takes the secondary-button shell and
  // holds the binding as a Kbd.
  chord: {
    minWidth: 96,
    height: control.md,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceCard,
  },
  chordHover: { backgroundColor: colors.surfaceHover },
  chordPressed: { backgroundColor: colors.surfaceActive },
  chordRecording: { borderColor: colors.borderFocus, backgroundColor: colors.accentSoft },
  hint: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: space.xs },
};
