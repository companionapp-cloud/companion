import { useCallback, useEffect, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { colors, radius, shadow } from "@companion/design-system";
import { CommandPalette, paletteEnter } from "./CommandPalette";
import { closeCaptureWindow, openCaptureResult } from "./capture";

// A blur this soon after opening is the panel settling in, not the user leaving.
const BLUR_GRACE_MS = 400;

/**
 * Desktop quick-capture window (opened by the global Option/Alt+Space shortcut, see
 * apps/desktop/main.go): the command palette in a frameless, transparent floating panel,
 * Spotlight-style — a card that hangs from the top of the window and grows with its results.
 * Capturing saves and closes; opening a result hands it to the main window (this webview has
 * no navigator of its own) and closes. Clicking outside the card, or another app taking
 * focus, dismisses it.
 */
export function CaptureView() {
  // Several things can dismiss the panel at once (opening a result also blurs it); the Wails
  // close must only be asked for once.
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    closeCaptureWindow();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const openedAt = Date.now();
    const onBlur = () => {
      if (Date.now() - openedAt < BLUR_GRACE_MS) return;
      // Focus moving between fields inside the page also blurs the window for a tick.
      setTimeout(() => {
        if (!document.hasFocus()) close();
      }, 80);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [close]);

  return (
    <View style={styles.root}>
      <Pressable style={styles.outside} onPress={close} aria-label="Close quick capture" />
      <View style={[styles.card, paletteEnter]}>
        <CommandPalette onClose={close} onOpen={openCaptureResult} attachments={false} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Transparent margin around the card so its drop shadow renders without being clipped at the
  // window bounds. Native window shadow is off (capture_darwin.go).
  root: { flex: 1, backgroundColor: "transparent", paddingHorizontal: 30, paddingTop: 20, paddingBottom: 40 },
  outside: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  // The same panel the in-app palette uses: overlay surface, hairline, 8px, shadow.lg. Sized by
  // its content, up to the window.
  card: {
    flexShrink: 1,
    minHeight: 0,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    overflow: "hidden",
    ...shadow.lg,
  },
});
