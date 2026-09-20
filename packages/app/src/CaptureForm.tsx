import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Button, Icon, Input, Text, colors, icon, radius, space, useDensity } from "@companion/design-system";
import { Editor, type EditorController, type FormatState } from "@companion/editor";
import { FormattingBar } from "./FormattingBar";
import { useCaptureController, type CaptureController } from "./useCaptureController";
import { Segmented } from "./settingsUi";
import { isMacPlatform } from "./shortcuts";

export interface CaptureFormProps {
  /** Called after a note/task is created, or when the user cancels — the host closes its
   *  surface (the desktop overlay panel, the mobile sheet). */
  onClose: () => void;
}

/**
 * The quick-capture form (PLAN §6.4): a two-question flow — a note/task segment row, then the
 * entry for that kind. The note body is the full note editor, hugging its content (headings,
 * lists, todos, tables, `[[` links and `![[` embeds — what is captured is already the note);
 * tasks take a title plus natural-language due / reminder fields, each echoing
 * what it parsed to. Hosted by the desktop shell's 460px overlay and the mobile bottom sheet;
 * behaviour lives in {@link useCaptureController}, and the global-shortcut window renders the
 * same pieces (see CaptureView). With a pointer, ⌘⏎ saves.
 */
export function CaptureForm({ onClose }: CaptureFormProps) {
  const c = useCaptureController(onClose);
  const touch = useDensity() === "touch";
  useSaveShortcut(c, !touch);

  // With a pointer the overlay opens ready to type: focus the note body once ProseMirror has
  // mounted (the task title autofocuses itself). Scoped to this form — the document behind
  // the overlay has editors of its own. On touch the sheet leaves the keyboard down.
  const formRef = useRef<unknown>(null);
  useEffect(() => {
    if (touch || Platform.OS !== "web" || c.kind !== "note" || typeof requestAnimationFrame === "undefined") return;
    const raf = requestAnimationFrame(() => {
      const root = formRef.current as { querySelector?: (sel: string) => { focus?: () => void } | null } | null;
      root?.querySelector?.(".ProseMirror")?.focus?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [touch, c.kind]);

  return (
    <View ref={formRef as never} style={styles.form}>
      {/* Q1: note or task */}
      <CaptureKindSwitch c={c} fill={touch} />

      {/* Q2: the form for that kind */}
      <CaptureFields c={c} />

      <View style={[styles.actions, touch ? null : styles.actionsEnd]}>
        {touch ? (
          <>
            <View style={styles.actionFill}>
              <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
            </View>
            <View style={styles.actionFill}>
              <Button label={saveLabel(c)} fullWidth disabled={!c.canSubmit || c.busy} onPress={() => void c.submit()} />
            </View>
          </>
        ) : (
          <>
            <Button label="Cancel" variant="ghost" onPress={onClose} />
            <Button label={saveLabel(c)} kbd={SAVE_HINT} disabled={!c.canSubmit || c.busy} onPress={() => void c.submit()} />
          </>
        )}
      </View>
    </View>
  );
}

/** ⌘⏎ on macOS, ctrl ⏎ elsewhere — the listener accepts either modifier. */
export const SAVE_HINT = Platform.OS === "web" && !isMacPlatform() ? "ctrl ⏎" : "⌘⏎";

export const saveLabel = (c: CaptureController) => (c.kind === "note" ? "Save note" : "Save task");

/** ⌘/Ctrl+Enter saves. Capture phase, so it wins over the focused ProseMirror editor (where a
 *  bare Enter is a new line). */
export function useSaveShortcut(c: CaptureController, enabled: boolean) {
  const { canSubmit, busy, submit } = c;
  useEffect(() => {
    if (!enabled || Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      e.stopPropagation();
      if (canSubmit && !busy) void submit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, canSubmit, busy, submit]);
}

/** The note/task switch: raised segment on a sunken hairline track. */
export function CaptureKindSwitch({ c, fill = false }: { c: CaptureController; fill?: boolean }) {
  return (
    <Segmented
      fill={fill}
      value={c.kind}
      onChange={c.setKind}
      options={[
        { value: "note", label: "Note", icon: "file", ariaLabel: "Capture a note" },
        { value: "task", label: "Task", icon: "tasks", ariaLabel: "Capture a task" },
      ]}
    />
  );
}

/** The entry for the chosen kind: the note's body, or the task questions. `hideTitle` drops
 *  the task's title question, for a host whose own input is the title (the command palette).
 *  `attachments` is off where a file picker can't be shown (see CaptureNoteBody). */
export function CaptureFields({ c, hideTitle = false, attachments = true }: { c: CaptureController; hideTitle?: boolean; attachments?: boolean }) {
  const touch = useDensity() === "touch";
  if (c.kind === "note") return <CaptureNoteBody c={c} attachments={attachments} />;
  const leading = (name: "calendar" | "bell") => <Icon name={name} size={touch ? icon.md : icon.sm} color={colors.textQuaternary} />;
  return (
    <View style={styles.fields}>
      {hideTitle ? null : (
        <Field label="What do you need to do?">
          <Input value={c.taskTitle} onChangeText={c.setTaskTitle} placeholder="e.g. Email the design draft" autoFocus />
        </Field>
      )}
      <Field label="When is this due?" hint={c.dueResolved} error={c.dueFailed ? "Couldn’t read a date — try “next friday”." : null}>
        <Input
          value={c.due}
          onChangeText={(t) => c.setDue(t)}
          onSubmitEditing={() => void c.previewDue()}
          onBlur={() => void c.previewDue()}
          placeholder="Natural language, e.g. tomorrow"
          leadingIcon={leading("calendar")}
        />
      </Field>
      <Field label="Do you want me to remind you?" hint={c.remindResolved} error={c.remindFailed ? "Couldn’t read that — try “tomorrow 9am” or “a day before”." : null}>
        <Input
          value={c.remind}
          onChangeText={(t) => c.setRemind(t)}
          onSubmitEditing={() => void c.previewRemind()}
          onBlur={() => void c.previewRemind()}
          placeholder="e.g. in 2 hours, or a day before"
          leadingIcon={leading("bell")}
        />
      </Field>
    </View>
  );
}

/** The note's body: the full editor in a box that hugs what is written, up to a cap where it
 *  scrolls, over the formatting bar (web; with a pointer always there, on touch while the body
 *  has focus). Markdown shortcuts format as they do in a note. Two things a captured note
 *  leaves for the note itself: drawing, and creating the target of an empty `[[link]]` (it
 *  stays text until then). Tables use the editor's own menu — the desktop's native one belongs
 *  to the main window. `attachments` hides the bar's attach button for the quick-capture
 *  window, which a file picker would blur and so dismiss; a pasted image still embeds. */
function CaptureNoteBody({ c, attachments }: { c: CaptureController; attachments: boolean }) {
  const touch = useDensity() === "touch";
  const editorRef = useRef<EditorController>(null);
  const [formatState, setFormatState] = useState<FormatState | null>(null);
  // A bar button briefly blurs the editor before its action refocuses it, so hiding waits a beat.
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFocusChange = useCallback((on: boolean) => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = null;
    if (on) setFocused(true);
    else blurTimer.current = setTimeout(() => setFocused(false), 200);
  }, []);
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );
  return (
    <View style={styles.noteBox}>
      <View style={[styles.noteBody, { minHeight: NOTE_MIN_HEIGHT + 2 * space.md }]}>
        <Editor
          ref={editorRef}
          inline
          markdown={c.noteDraft}
          onChangeMarkdown={c.setNoteDraft}
          placeholder="Type anything. Markdown formats as you go; [[ links, ![[ embeds."
          linkSource={c.linkSource}
          documentSource={c.documentSource}
          linkRevision={c.linkRevision}
          onFormatStateChange={setFormatState}
          onFocusChange={onFocusChange}
          // Prompt reports, so Save enables as soon as there is something to save.
          debounceMs={150}
          minHeight={NOTE_MIN_HEIGHT}
          maxHeight={touch ? 220 : 280}
        />
      </View>
      {Platform.OS === "web" && (!touch || focused) ? <FormattingBar state={formatState} editorRef={editorRef} canAttach={attachments && !!c.documentSource} /> : null}
    </View>
  );
}

// Five rows of 14/22 prose.
const NOTE_MIN_HEIGHT = 110;

/** A labelled field that echoes what a natural-language phrase parsed to as mono `→ …`, or
 *  says why it couldn't be read. */
function Field({ label, hint, error, children }: { label: string; hint?: string | null; error?: string | null; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="label">{label}</Text>
      {children}
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="mono" tone="quaternary">
          → {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.ml },
  noteBox: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  noteBody: { paddingHorizontal: space.ml, paddingVertical: space.md },
  fields: { gap: space.ml },
  field: { gap: space.xs },
  actions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  actionsEnd: { justifyContent: "flex-end" },
  actionFill: { flex: 1 },
});
