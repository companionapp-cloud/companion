import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { Button, Input, Text, colors, radius, shadow, space, useDensity } from "@companion/design-system";
import { NavContext } from "./nav-context";

export interface ConfirmDialogProps {
  title: string;
  /** Explanatory body copy. Plain text is wrapped in a muted paragraph; pass a node for
   *  richer content. */
  message?: ReactNode;
  /** Confirm button label (default "Delete"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** When set, the user must type this exact string to enable the confirm button — the
   *  extra-friction guard used for irreversible destroys (e.g. a project's name). */
  confirmText?: string;
  /** Prompt shown above the type-to-confirm input. */
  confirmTextPrompt?: ReactNode;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

/** Wires ⏎ / esc for a dialog while it is open, and reports whether the hints should show.
 *  Web + pointer density only (a phone has no keys to hint at), and only in the visible tab —
 *  a dialog left open in a background tab must not act on a keypress meant for another.
 *  Capture phase, so the editor or overlay underneath never sees the key. A focused button
 *  keeps its own Enter, so tabbing to Cancel and pressing ⏎ still cancels. */
export function useDialogKeys({ onEnter, onEscape }: { onEnter?: () => void; onEscape?: () => void }): boolean {
  const density = useDensity();
  const visible = useContext(NavContext)?.visible ?? true;
  const enabled = Platform.OS === "web" && density === "pointer" && typeof window !== "undefined";
  const handlers = useRef({ onEnter, onEscape });
  handlers.current = { onEnter, onEscape };

  // The control that opened the dialog still holds focus; drop it so ⏎ reaches the dialog
  // instead of re-pressing that control. (An autoFocus field takes focus after this.)
  useEffect(() => {
    if (!enabled) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active.tagName !== "INPUT" && active.tagName !== "TEXTAREA") active.blur?.();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && handlers.current.onEscape) {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onEscape();
      } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && handlers.current.onEnter) {
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === "BUTTON" || active.getAttribute("role") === "button")) return;
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onEnter();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, visible]);

  return enabled;
}

/** A modal confirmation over the scrim: an overlay panel with the title, the consequence,
 *  and a right-aligned Cancel / confirm footer. No entrance animation. Cross-
 *  platform (RN primitives → works on web via react-native-web and on native). The
 *  `confirmText` variant requires typing an exact string before the destructive action
 *  unlocks; otherwise a single Confirm press suffices. The host is expected to unmount
 *  this on a successful confirm (via navigation or its own state). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  confirmText,
  confirmTextPrompt,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const needsMatch = confirmText != null && confirmText.length > 0;
  const canConfirm = !busy && (!needsMatch || typed === confirmText);

  const confirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    try {
      await onConfirm();
      // On success the host unmounts us (navigation / removed from the tree), so we
      // deliberately don't reset `busy` here — only on failure below.
    } catch {
      setBusy(false);
    }
  };

  const hints = useDialogKeys({ onEnter: () => void confirm(), onEscape: busy ? undefined : onClose });

  return (
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label={cancelLabel} />
      <View style={styles.card}>
        <Text variant="title">{title}</Text>
        {message != null ? (
          typeof message === "string" ? (
            <Text tone="secondary" style={styles.message}>
              {message}
            </Text>
          ) : (
            message
          )
        ) : null}
        {needsMatch ? (
          <View style={styles.confirmField}>
            {confirmTextPrompt != null ? (
              typeof confirmTextPrompt === "string" ? (
                <Text variant="caption" tone="tertiary">
                  {confirmTextPrompt}
                </Text>
              ) : (
                confirmTextPrompt
              )
            ) : null}
            <Input
              autoFocus
              autoCapitalize="none"
              value={typed}
              onChangeText={setTyped}
              placeholder={confirmText}
            />
          </View>
        ) : null}
        <View style={styles.actions}>
          <Button label={cancelLabel} variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          <Button label={confirmLabel} variant="danger" kbd={hints ? "⏎" : undefined} disabled={!canConfirm} onPress={() => void confirm()} />
        </View>
      </View>
    </View>
  );
}

const styles = {
  scrim: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: colors.scrim,
    padding: space.xl,
    zIndex: 100,
  },
  scrimFill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  card: {
    width: 400,
    maxWidth: "100%" as const,
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    padding: space.xl,
    gap: space.md,
  },
  message: { lineHeight: 19 },
  confirmField: { gap: space.sm },
  actions: {
    flexDirection: "row" as const,
    justifyContent: "flex-end" as const,
    gap: space.sm,
    marginTop: space.sm,
  },
};
