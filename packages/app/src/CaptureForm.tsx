import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Icon, Input, colors, font, radius, space } from "@companion/design-system";
import { Editor } from "@companion/editor";
import { useCaptureController } from "./useCaptureController";

export interface CaptureFormProps {
  /** Called after a note/task is created, or when the user cancels — the host closes its
   *  surface (the mobile sheet). */
  onClose: () => void;
}

/**
 * The mobile quick-add form (PLAN §6.4): a two-question flow — note/task pill toggle, then the
 * entry for that kind. The note body is the simple ProseMirror editor (so `[[` links and `![[`
 * embeds work); tasks take a title plus natural-language due / reminder fields. Behaviour lives
 * in {@link useCaptureController}; the desktop window renders the same controller in its own
 * visual language (see CaptureView).
 */
export function CaptureForm({ onClose }: CaptureFormProps) {
  const c = useCaptureController(onClose);

  return (
    <View>
      {/* Q1: note or task */}
      <View style={styles.segment}>
        {(["note", "task"] as const).map((k) => {
          const active = c.kind === k;
          return (
            <Pressable
              key={k}
              onPress={() => c.setKind(k)}
              style={[styles.segmentBtn, active ? styles.segmentBtnActive : null]}
              aria-label={k === "note" ? "Capture a note" : "Capture a task"}
            >
              <Icon name={k === "note" ? "notes" : "tasks"} size={15} color={active ? colors.textInverse : colors.textSecondary} />
              <Text style={[styles.segmentLabel, { color: active ? colors.textInverse : colors.textSecondary }]}>
                {k === "note" ? "Note" : "Task"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Q2: the form for that kind */}
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
            minHeight={140}
          />
        </View>
      ) : (
        <View style={{ gap: space.lg }}>
          <Field label="What do you need to do?">
            <TextInput
              value={c.taskTitle}
              onChangeText={c.setTaskTitle}
              placeholder="e.g. Email the design draft"
              placeholderTextColor={colors.textTertiary}
              autoFocus
              style={styles.taskTitleInput}
            />
          </Field>
          <Field label="When is this due?" hint={c.dueResolved} error={c.dueFailed ? "Couldn't read a date — try “next friday”." : null}>
            <Input
              size="sm"
              value={c.due}
              onChangeText={(t) => c.setDue(t)}
              onSubmitEditing={() => void c.previewDue()}
              onBlur={() => void c.previewDue()}
              placeholder="Natural language, e.g. tomorrow"
              leadingIcon={<Icon name="calendar" size={14} color={colors.textTertiary} />}
            />
          </Field>
          <Field
            label="Do you want me to remind you?"
            hint={c.remindResolved}
            error={c.remindFailed ? "Couldn't read a time — try “tomorrow 9am”." : null}
          >
            <Input
              size="sm"
              value={c.remind}
              onChangeText={(t) => c.setRemind(t)}
              onSubmitEditing={() => void c.previewRemind()}
              onBlur={() => void c.previewRemind()}
              placeholder="Natural language, e.g. in 2 hours"
              leadingIcon={<Icon name="calendar" size={14} color={colors.textTertiary} />}
            />
          </Field>
        </View>
      )}

      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.btnGhost]} onPress={onClose}>
          <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnPrimary, !c.canSubmit || c.busy ? styles.btnDisabled : null]}
          onPress={() => void c.submit()}
          disabled={!c.canSubmit || c.busy}
        >
          <Text style={[styles.btnLabel, { color: colors.textInverse }]}>{c.kind === "note" ? "Save note" : "Save task"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** A labelled field with an optional resolved-date hint (green confirmation of what a NL phrase
 *  parsed to) or an error line. */
function Field({ label, hint, error, children }: { label: string; hint?: string | null; error?: string | null; children: ReactNode }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {error ? (
        <Text style={[styles.fieldCaption, { color: colors.accent }]}>{error}</Text>
      ) : hint ? (
        <Text style={[styles.fieldCaption, { color: colors.success }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: "row",
    gap: space.xs,
    padding: 3,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSunken,
    marginBottom: space.lg,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    height: 38,
    borderRadius: radius.full,
  },
  segmentBtnActive: { backgroundColor: colors.accent },
  segmentLabel: { fontFamily: font.sans, fontSize: font.size.sm, fontWeight: font.weight.semibold },
  noteBox: {
    minHeight: 140,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  taskTitleInput: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    height: 46,
    fontSize: 15,
    fontFamily: font.sans,
    color: colors.textPrimary,
  },
  actions: { flexDirection: "row", gap: space.md, marginTop: space.lg },
  btn: { flex: 1, height: 46, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  btnGhost: { borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.surfaceCard },
  btnPrimary: { backgroundColor: colors.accent },
  btnDisabled: { opacity: 0.4 },
  btnLabel: { fontFamily: font.sans, fontSize: font.size.base, fontWeight: font.weight.semibold },
  fieldLabel: { fontFamily: font.sans, fontSize: font.size.sm, fontWeight: font.weight.medium, color: colors.textSecondary },
  fieldCaption: { fontFamily: font.sans, fontSize: font.size.xs },
});
