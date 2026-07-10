import { useMemo, useState } from "react";
import type { DocumentSource, LinkSource } from "@companion/editor";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useCore } from "./CoreContext";
import { useLinkSource } from "./useLinkSource";
import { useDocumentSource } from "./DocumentSourceContext";

export type CaptureKind = "note" | "task";

/** The shared state + behaviour behind quick capture (PLAN §6.4), factored out so the mobile
 *  sheet and the desktop window can present it in their own visual language while behaving
 *  identically. A two-question flow: pick note/task, fill it, create-and-close. */
export interface CaptureController {
  kind: CaptureKind;
  setKind: (k: CaptureKind) => void;

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

export function useCaptureController(onClose: () => void): CaptureController {
  const notes = useNotes();
  const tasks = useTasks();
  const { dates } = useCore();
  const linkSource = useLinkSource();
  const documentSource = useDocumentSource();

  const [kind, setKind] = useState<CaptureKind>("note");
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
  const previewRemind = async () => {
    const r = await parseNl(remind);
    setRemindFailed(r === "invalid");
    setRemindResolved(typeof r === "string" && r !== "invalid" ? formatResolved(r) : null);
  };

  const saveNote = async () => {
    const text = noteDraft.trim();
    if (!text || busy) return;
    setBusy(true);
    const title = text.split("\n")[0].slice(0, 60);
    await notes.create({ title, contentMd: text });
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
    const remindAt = await parseNl(remind);
    if (remindAt === "invalid") {
      setRemindFailed(true);
      setBusy(false);
      return;
    }
    await tasks.create({ title, dueAt: dueAt ?? undefined, remindAt: remindAt ?? undefined });
    onClose();
  };

  const canSubmit = kind === "note" ? noteDraft.trim().length > 0 : taskTitle.trim().length > 0;
  const submit = kind === "note" ? saveNote : saveTask;

  return useMemo(
    () => ({
      kind,
      setKind,
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
    [kind, noteDraft, taskTitle, due, dueResolved, dueFailed, remind, remindResolved, remindFailed, busy, canSubmit, tasks.tasks, linkSource, documentSource],
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
