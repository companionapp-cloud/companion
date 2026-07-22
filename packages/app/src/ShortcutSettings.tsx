import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Text, colors, radius, space, type PressState } from "@companion/design-system";
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
    <View style={{ gap: space.md }}>
      <Text variant="caption" tone="tertiary" style={{ lineHeight: 18 }}>
        Shortcuts work system-wide, so they win over whatever app you’re in — pick a chord no
        other app needs. This only applies to this device.
      </Text>
      <View style={styles.card}>
        {SHORTCUTS.map((s, i) => {
          const binding = bindings?.find((b) => b.id === s.id);
          const isRecording = recording === s.id;
          const isDefault = !!binding && binding.accelerator === binding.defaultAccelerator;
          return (
            <View key={s.id} style={[styles.row, i === SHORTCUTS.length - 1 ? null : styles.rowDivider]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text>{s.label}</Text>
                <Text variant="caption" tone="tertiary" style={{ lineHeight: 18 }}>
                  {s.description}
                </Text>
              </View>
              {binding && !isDefault ? (
                <Button
                  label="Reset"
                  variant="secondary"
                  onPress={() => void rebind(s.id, binding.defaultAccelerator)}
                />
              ) : null}
              <Pressable
                onPress={() => setRecording(isRecording ? null : s.id)}
                aria-label={isRecording ? `Press the new shortcut for ${s.label}` : `Change the ${s.label} shortcut`}
                style={({ hovered }: PressState) => [
                  styles.chord,
                  isRecording ? styles.chordRecording : hovered ? styles.chordHover : null,
                ]}
              >
                <Text variant="mono" tone={isRecording ? "accent" : undefined}>
                  {isRecording ? "Press keys…" : binding ? formatAccelerator(binding.accelerator) : "—"}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      {recording ? (
        <Text variant="caption" tone="tertiary">
          Hold a modifier (⌥, ⌃, ⇧, ⌘) and press a key. Esc cancels.
        </Text>
      ) : null}
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = {
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden" as const,
  },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: colors.surfaceCard,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  chord: {
    minWidth: 104,
    alignItems: "center" as const,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  chordHover: { backgroundColor: colors.surfaceHover },
  chordRecording: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
};
