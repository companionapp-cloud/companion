import { useEffect, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, Icon, Input, Text, colors, dragRegion, font, radius, shadow, space } from "@companion/design-system";
import { Editor } from "@companion/editor";
import { useCaptureController, type CaptureKind } from "./useCaptureController";
import { closeCaptureWindow } from "./capture";

/**
 * Desktop quick-capture window (opened by the global Option/Alt+Space shortcut, see
 * apps/desktop/main.go): the shared capture controller in a frameless, rounded floating panel,
 * styled to match the desktop app (subtle segmented control, design-system inputs + buttons).
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

  // Global shortcuts. Capture phase so they win over the focused ProseMirror editor / fields.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeCaptureWindow();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (c.canSubmit && !c.busy) void c.submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [c.canSubmit, c.busy, c.submit]);

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        {/* Slim drag handle so the frameless window can be moved (dragRegion is a no-op off desktop). */}
        <View style={[styles.dragBar, dragRegion]}>
          <View style={styles.grabber} />
        </View>

        <View style={styles.body}>
          <Segmented kind={c.kind} onChange={c.setKind} />

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {c.kind === "note" ? (
              <View style={styles.noteBox}>
                <Editor
                  variant="simple"
                  markdown={c.noteDraft}
                  onChangeMarkdown={c.setNoteDraft}
                  placeholder="Type anything. Use [[ to link or ![[ to embed."
                  linkSource={c.linkSource}
                  documentSource={c.documentSource}
                  linkRevision={c.linkRevision}
                  minHeight={150}
                />
              </View>
            ) : (
              <View style={{ gap: space.lg }}>
                <Field label="What do you need to do?">
                  <Input
                    value={c.taskTitle}
                    onChangeText={c.setTaskTitle}
                    placeholder="e.g. Email the design draft"
                  />
                </Field>
                <Field label="When is this due?" hint={c.dueResolved} error={c.dueFailed ? "Couldn't read a date — try “next friday”." : null}>
                  <Input
                    size="sm"
                    value={c.due}
                    onChangeText={c.setDue}
                    onSubmitEditing={() => void c.previewDue()}
                    onBlur={() => void c.previewDue()}
                    placeholder="Natural language, e.g. tomorrow"
                    leadingIcon={<Icon name="calendar" size={14} color={colors.textTertiary} />}
                  />
                </Field>
                <Field label="Remind me?" hint={c.remindResolved} error={c.remindFailed ? "Couldn't read a time — try “tomorrow 9am”." : null}>
                  <Input
                    size="sm"
                    value={c.remind}
                    onChangeText={c.setRemind}
                    onSubmitEditing={() => void c.previewRemind()}
                    onBlur={() => void c.previewRemind()}
                    placeholder="Natural language, e.g. in 2 hours"
                    leadingIcon={<Icon name="bell" size={14} color={colors.textTertiary} />}
                  />
                </Field>
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <Text variant="caption" tone="tertiary">
              ⌘↵ to save · Esc to close
            </Text>
            <View style={styles.actions}>
              <Button label="Cancel" variant="secondary" size="sm" onPress={closeCaptureWindow} />
              <Button
                label={c.kind === "note" ? "Save note" : "Save task"}
                size="sm"
                disabled={!c.canSubmit || c.busy}
                onPress={() => void c.submit()}
              />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

/** The desktop note/task switch: a raised chip on a sunken track, matching the app's tabs. */
function Segmented({ kind, onChange }: { kind: CaptureKind; onChange: (k: CaptureKind) => void }) {
  return (
    <View style={styles.segment}>
      {(["note", "task"] as const).map((k) => {
        const active = kind === k;
        return (
          <Pressable
            key={k}
            onPress={() => onChange(k)}
            aria-label={k === "note" ? "Capture a note" : "Capture a task"}
            style={[styles.segmentBtn, active ? styles.segmentBtnActive : null]}
          >
            <Icon name={k === "note" ? "notes" : "tasks"} size={14} color={active ? colors.accentHover : colors.textTertiary} />
            <Text variant="caption" tone={active ? "default" : "secondary"} style={{ fontWeight: font.weight.semibold }}>
              {k === "note" ? "Note" : "Task"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string | null; error?: string | null; children: ReactNode }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="caption" tone="secondary" style={{ fontWeight: font.weight.medium }}>
        {label}
      </Text>
      {children}
      {error ? (
        <Text variant="caption" tone="accent">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" style={{ color: colors.success }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Transparent margin around the card so its drop shadow renders without being clipped at the
  // window bounds. Native window shadow is off (capture_darwin.go).
  root: { flex: 1, backgroundColor: "transparent", paddingHorizontal: 30, paddingTop: 20, paddingBottom: 40 },
  card: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.xl,
    overflow: "hidden",
    shadowColor: "#111110",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
    elevation: 12,
  },
  dragBar: { height: 20, alignItems: "center", justifyContent: "center" },
  grabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderDefault },
  body: { flex: 1, minHeight: 0, paddingHorizontal: space.xl, paddingBottom: space.lg, gap: space.lg },
  segment: {
    flexDirection: "row",
    alignSelf: "flex-start",
    gap: 2,
    padding: 2,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken,
  },
  segmentBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
  },
  segmentBtnActive: { backgroundColor: colors.surfaceCard, ...shadow.sm },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: space.sm },
  noteBox: {
    minHeight: 150,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  actions: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
