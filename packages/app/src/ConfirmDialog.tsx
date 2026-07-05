import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Button, Input, Text, colors, radius, shadow, space } from "@companion/design-system";

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

/** A modal confirmation over a dimmed scrim, styled to match MembershipPicker. Cross-
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
          <Button label={cancelLabel} variant="secondary" onPress={onClose} />
          <Button label={confirmLabel} variant="danger" disabled={!canConfirm} onPress={() => void confirm()} />
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
    backgroundColor: "rgba(17,17,16,0.28)",
    padding: space.xl,
    zIndex: 100,
  },
  scrimFill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  card: {
    width: 400,
    maxWidth: "100%" as const,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    padding: space.xl,
    gap: space.md,
  },
  message: { lineHeight: 20 },
  confirmField: { gap: space.sm },
  actions: {
    flexDirection: "row" as const,
    justifyContent: "flex-end" as const,
    gap: space.md,
    marginTop: space.sm,
  },
};
