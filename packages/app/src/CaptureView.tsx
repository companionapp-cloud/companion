import { useEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Icon, IconButton, Text, colors, dragRegion, icon, noDragRegion, radius, shadow, space } from "@companion/design-system";
import { useCaptureController } from "./useCaptureController";
import { closeCaptureWindow } from "./capture";
import { CaptureFields, CaptureKindSwitch, SAVE_HINT, saveLabel, useSaveShortcut } from "./CaptureForm";

/**
 * Desktop quick-capture window (opened by the global Option/Alt+Space shortcut, see
 * apps/desktop/main.go): the shared capture controller and the same fields as the in-app
 * overlay (see CaptureForm), in a frameless floating panel — a segment row that doubles as the
 * drag handle, the entry, then a Cancel / Save footer with its shortcuts spelled out.
 * Fully keyboard-driven — focuses the input on open, Tab between fields, Cmd+Enter submits,
 * Esc closes.
 */
export function CaptureView() {
  const c = useCaptureController(closeCaptureWindow);

  // Focus the active kind's first input on open and whenever the kind changes. rAF lets the
  // ProseMirror editor finish mounting before we reach for its contenteditable. The capture
  // window's document holds only this form, so a document-wide query is unambiguous.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const raf = requestAnimationFrame(() => {
      const target =
        c.kind === "note"
          ? document.querySelector<HTMLElement>(".ProseMirror")
          : document.querySelector<HTMLElement>("input, textarea");
      target?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [c.kind]);

  // Esc closes. Capture phase so it wins over the focused ProseMirror editor / fields.
  // (⌘⏎ is the shared save shortcut below.)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeCaptureWindow();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  useSaveShortcut(c, true);

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        {/* The header row doubles as the drag handle, so the frameless window can be moved
            (dragRegion is a no-op off desktop; the switch and close button opt back out). */}
        <View style={[styles.header, dragRegion]}>
          <View style={noDragRegion}>
            <CaptureKindSwitch c={c} />
          </View>
          <View style={{ flex: 1 }} />
          <Icon name="capture" size={icon.sm} color={colors.textQuaternary} />
          <Text variant="mono" tone="quaternary">
            quick capture
          </Text>
          <IconButton label="Close" size="sm" onPress={closeCaptureWindow}>
            <Icon name="close" size={icon.sm} color={colors.textSecondary} />
          </IconButton>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <CaptureFields c={c} />
        </ScrollView>

        <View style={styles.footer}>
          <Button label="Cancel" variant="ghost" kbd="esc" onPress={closeCaptureWindow} />
          <Button label={saveLabel(c)} kbd={SAVE_HINT} disabled={!c.canSubmit || c.busy} onPress={() => void c.submit()} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Transparent margin around the card so its drop shadow renders without being clipped at the
  // window bounds. Native window shadow is off (capture_darwin.go).
  root: { flex: 1, backgroundColor: "transparent", paddingHorizontal: 30, paddingTop: 20, paddingBottom: 40 },
  // The same panel the in-app quick capture uses: overlay surface, hairline, 8px, shadow.lg.
  card: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    overflow: "hidden",
    ...shadow.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  scroll: { flex: 1 },
  scrollContent: { padding: space.lg },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    flexShrink: 0,
  },
});
