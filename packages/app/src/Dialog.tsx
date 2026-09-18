import type { ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { Text, colors, radius, shadow, space } from "@companion/design-system";
import { Overlay } from "./Overlay";

/** The shared modal shell: a scrim that closes on an outside click, and a titled overlay card
 *  whose body scrolls when the window is short. Same look as {@link ConfirmDialog}; this one is
 *  for forms, which are tall and opened from anywhere — including a settings section only a few
 *  lines high, or a scrolling settings page on a phone — so it always covers the whole window
 *  rather than whatever container it was rendered in: portaled to the document root and pinned to
 *  the viewport on web, a transparent native `Modal` elsewhere (as the mobile sheets are).
 *  Keyboard handling stays with the caller (`useDialogKeys`), which knows what ⏎ means. */
export function Dialog({
  title,
  onClose,
  width = 440,
  children,
  footer,
}: {
  title: string;
  /** Omit (or pass undefined while busy) to make the scrim inert. */
  onClose?: () => void;
  width?: number;
  children: ReactNode;
  /** Pinned under the scrolling body — the action row. */
  footer?: ReactNode;
}) {
  const panel = (
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label="Close" />
      <View style={[styles.card, { width }]}>
        <Text variant="title">{title}</Text>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
          {children}
        </ScrollView>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    </View>
  );
  if (Platform.OS === "web") return <Overlay>{panel}</Overlay>;
  return (
    // onRequestClose is Android's hardware back button.
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {panel}
    </Modal>
  );
}

const styles = {
  scrim: {
    // Portaled to document.body on web, so `fixed` pins it to the viewport above every pane.
    position: (Platform.OS === "web" ? "fixed" : "absolute") as "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: colors.scrim,
    padding: space.xl,
    zIndex: 1000,
  },
  scrimFill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  card: {
    maxWidth: "100%" as const,
    maxHeight: "100%" as const,
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    padding: space.xl,
    gap: space.md,
  },
  // flexShrink lets the body give way (and scroll) before the title or the buttons do.
  scroll: { flexShrink: 1 },
  body: { gap: space.md },
  footer: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: space.sm, marginTop: space.xs },
};
