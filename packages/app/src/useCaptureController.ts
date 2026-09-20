import { useMemo, useRef, useState } from "react";
import type { TaskReminder } from "@companion/core-bridge";
import type { DocumentSource, LinkSource } from "@companion/editor";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useCore } from "./CoreContext";
import { useLinkSource } from "./useLinkSource";
import { useDocumentSource } from "./DocumentSourceContext";
import type { DocRef } from "./nav-context";
import { reminderLabel } from "./reminders";

export type CaptureKind = "note" | "task";

/** The shared state + behaviour behind quick capture (PLAN §6.4), factored out so the mobile
 *  sheet and the desktop window can present it in their own visual language while behaving
 *  identically. A two-question flow: pick note/task, fill it, create-and-close. */
export interface CaptureController {
  kind: CaptureKind;
  setKind: (k: CaptureKind) => void;

  /** The note's title. Optional — hosts without a title field (the mobile sheet) leave it
   *  empty and the body's first line stands in. */
  noteTitle: string;
  setNoteTitle: (t: string) => void;
  noteDraft: string;
  setNoteDraft: (md: string) => void;

  taskTitle: string;
  setTaskTitle: (t: string) => void;

  due: string;
  setDue: (t: string) => void;
  dueResolved: string | null;
  dueFailed: boolean;
  previewDue: () => Promise<void>;

  remind: string;
  setRemind: (t: string) => void;
  remindResolved: string | null;
  remindFailed: boolean;
  previewRemind: () => Promise<void>;

  busy: boolean;
  canSubmit: boolean;
  submit: () => Promise<void>;

  // Editor wiring for the note body.
  linkSource: LinkSource;
  documentSource: DocumentSource | undefined;
  /** Identity changes when task data does, so `[[task:…]]` chips re-hydrate. */
  linkRevision: unknown;
}

export interface CaptureOptions {
  /** Runs once the note or task is saved, before the surface closes — how a host files it
   *  somewhere (the command palette's project chips, or the project on screen) and follows it
   *  into the app (its ⇧⏎). A failure here never loses what was saved. */
  onCreated?: (doc: DocRef) => Promise<void> | void;
}

export function useCaptureController(onClose: () => void, options?: CaptureOptions): CaptureController {
  // Read at save time: `submit` is memoized below and would otherwise hold a stale callback.
  const onCreated = useRef(options?.onCreated);
  onCreated.current = options?.onCreated;

  const notes = useNotes();
  const tasks = useTasks();
  const { dates, tasks: tasksApi } = useCore();
  const linkSource = useLinkSource();
  const documentSource = useDocumentSource();

  const [kind, setKind] = useState<CaptureKind>("note");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [due, setDue] = useState("");
  const [dueResolved, setDueResolved] = useState<string | null>(null);
  const [dueFailed, setDueFailed] = useState(false);
  const [remind, setRemind] = useState("");
  const [remindResolved, setRemindResolved] = useState<string | null>(null);
  const [remindFailed, setRemindFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Parse a natural-language field: the ISO timestamp, `null` when empty, or 'invalid' when it
  // couldn't be understood. Shared by the live preview and the final submit.
  const parseNl = async (text: string): Promise<string | null | "invalid"> => {
    const t = text.trim();
    if (!t) return null;
    const parsed = await dates.parse(t);
    return parsed ? parsed.at : "invalid";
  };

  const previewDue = async () => {
    const r = await parseNl(due);
    setDueFailed(r === "invalid");
    setDueResolved(typeof r === "string" && r !== "invalid" ? formatResolved(r) : null);
  };
  // The reminder field reads either kind (parsed in core): a time ("tomorrow 9am") or a lead
  // before the deadline typed above it ("a day before"). `null` when empty, 'invalid' when
  // neither reads.
  const parseReminder = async (text: string): Promise<TaskReminder | null | "invalid"> => {
    const t = text.trim();
    if (!t) return null;
    const { reminder } = await tasksApi.parseReminder(t);
    return reminder ?? "invalid";
  };
  const previewRemind = async () => {
    const r = await parseReminder(remind);
    setRemindFailed(r === "invalid");
    if (!r || r === "invalid") {
      setRemindResolved(null);
    } else if (r.at) {
      setRemindResolved(formatResolved(r.at));
    } else {
      // A lead only fires once the task has a deadline; say so while the field above is empty.
      const label = reminderLabel(r);
      const lead = label === "At deadline" ? "At the deadline" : `${label} the deadline`;
      setRemindResolved(due.trim() ? lead : `${lead} — set one above`);
    }
  };

  const created = async (doc: DocRef) => {
    try {
      await onCreated.current?.(doc);
    } catch (err) {
      console.warn(`capture: the ${doc.kind} was saved, but the host's follow-up failed`, err);
    }
  };

  const saveNote = async () => {
    const text = noteDraft.trim();
    const title = noteTitle.trim() || text.split("\n")[0].slice(0, 60);
    if (!title || busy) return;
    setBusy(true);
    const note = await notes.create({ title, contentMd: text });
    await created({ kind: "note", id: note.id });
    onClose();
  };

  const saveTask = async () => {
    const title = taskTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    const dueAt = await parseNl(due);
    if (dueAt === "invalid") {
      setDueFailed(true);
      setBusy(false);
      return;
    }
    const reminder = await parseReminder(remind);
    if (reminder === "invalid") {
      setRemindFailed(true);
      setBusy(false);
      return;
    }
    const task = await tasks.create({ title, dueAt: dueAt ?? undefined, reminders: reminder ? [reminder] : undefined });
    await created({ kind: "task", id: task.id });
    onClose();
  };

  const canSubmit = kind === "note" ? (noteTitle + noteDraft).trim().length > 0 : taskTitle.trim().length > 0;
  const submit = kind === "note" ? saveNote : saveTask;

  return useMemo(
    () => ({
      kind,
      setKind,
      noteTitle,
      setNoteTitle,
      noteDraft,
      setNoteDraft,
      taskTitle,
      setTaskTitle,
      due,
      setDue,
      dueResolved,
      dueFailed,
      previewDue,
      remind,
      setRemind,
      remindResolved,
      remindFailed,
      previewRemind,
      busy,
      canSubmit,
      submit,
      linkSource,
      documentSource,
      linkRevision: tasks.tasks,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, noteTitle, noteDraft, taskTitle, due, dueResolved, dueFailed, remind, remindResolved, remindFailed, busy, canSubmit, tasks.tasks, linkSource, documentSource],
  );
}

/** "Tue, Jul 8 · 9:00 AM" — the confirmation of a natural-language date/time. */
export function formatResolved(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}
