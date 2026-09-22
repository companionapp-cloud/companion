import { useCallback, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import type { CalendarFeed, TaskReminder } from "@companion/core-bridge";
import type { DocumentSource, LinkSource } from "@companion/editor";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useCalendar } from "./CalendarProvider";
import { useCore } from "./CoreContext";
import { useLinkSource } from "./useLinkSource";
import { useDocumentSource } from "./DocumentSourceContext";
import type { DocRef } from "./nav-context";
import { reminderLabel } from "./reminders";
import { WHEN_MISSING, eventTimes, readEvent, type EventReading } from "./eventCapture";
import { localDay } from "./paletteModel";

export type CaptureKind = "note" | "task" | "event";

/** The shared state + behaviour behind quick capture (PLAN §6.4), factored out so the mobile
 *  sheet and the desktop window can present it in their own visual language while behaving
 *  identically. A two-question flow: pick note/task/event, fill it, create-and-close. */
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

  /** Whether events can be captured: some calendar takes new ones (a CalDAV calendar that
   *  isn't read-only). Hosts offer the event kind only then. */
  canCaptureEvents: boolean;
  eventTitle: string;
  setEventTitle: (t: string) => void;
  /** "When is it?" — a day ("friday": all day) or a time ("friday 3pm"). */
  eventWhen: string;
  setEventWhen: (t: string) => void;
  /** What it read as: the span, lengths included ("Tue, Sep 23 · 3:00 PM – 4:00 PM"), or just
   *  the start while the length doesn't read. */
  eventWhenResolved: string | null;
  eventWhenError: string | null;
  /** "For how long?" — a length ("90 min", "2 days") or an end ("until 5pm"); an hour, or the
   *  one day, when blank. */
  eventLength: string;
  setEventLength: (t: string) => void;
  eventLengthResolved: string | null;
  eventLengthError: string | null;
  /** Re-read both answers into the echoes above. */
  previewEvent: () => Promise<void>;
  /** The calendars a new event can go in. */
  eventFeeds: CalendarFeed[];
  /** The one it goes in: the picked one, else the host's preference, else the first. */
  eventFeedId: string | null;
  setEventFeedId: (id: string) => void;
  /** Why the provider-side save failed, when it did. */
  eventError: string | null;

  busy: boolean;
  canSubmit: boolean;
  /** Save, then close. `feedId` saves an event into that calendar instead of the picked one —
   *  the command palette's ⏎ on a focused calendar chip. */
  submit: (opts?: CaptureSubmitOptions) => Promise<void>;

  // Editor wiring for the note body.
  linkSource: LinkSource;
  documentSource: DocumentSource | undefined;
  /** Identity changes when task data does, so `[[task:…]]` chips re-hydrate. */
  linkRevision: unknown;
}

export interface CaptureSubmitOptions {
  feedId?: string;
}

export interface CaptureOptions {
  /** Runs once the note or task is saved, before the surface closes — how a host files it
   *  somewhere (the command palette's project chips, or the project on screen) and follows it
   *  into the app (its ⇧⏎). A failure here never loses what was saved. */
  onCreated?: (doc: DocRef) => Promise<void> | void;
  /** Runs once an event is saved, before the surface closes, with the local day it starts on —
   *  how the command palette follows it into the calendar (its ⇧⏎). */
  onEventCreated?: (day: string) => void;
  /** Where a new event goes until a calendar is picked — the palette's: a calendar the project
   *  on screen holds. Ignored unless it takes new events; the first that does is the fallback. */
  eventFeedId?: string | null;
}

export function useCaptureController(onClose: () => void, options?: CaptureOptions): CaptureController {
  // Read at save time: `submit` is memoized below and would otherwise hold a stale callback.
  const onCreated = useRef(options?.onCreated);
  onCreated.current = options?.onCreated;
  const onEventCreated = useRef(options?.onEventCreated);
  onEventCreated.current = options?.onEventCreated;

  const notes = useNotes();
  const tasks = useTasks();
  const { writableFeeds, createEvent } = useCalendar();
  const { dates, tasks: tasksApi } = useCore();
  const linkSource = useLinkSource();
  const documentSource = useDocumentSource();

  const [kind, setKind] = useState<CaptureKind>("note");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteDraft, setNoteDraftState] = useState("");
  // The body as last reported, read at save time: ⌘⏎ flushes the editor (below), and that
  // report lands after this render's `noteDraft` was captured.
  const noteDraftRef = useRef("");
  const setNoteDraft = useCallback((md: string) => {
    noteDraftRef.current = md;
    setNoteDraftState(md);
  }, []);
  const [taskTitle, setTaskTitle] = useState("");
  const [due, setDue] = useState("");
  const [dueResolved, setDueResolved] = useState<string | null>(null);
  const [dueFailed, setDueFailed] = useState(false);
  const [remind, setRemind] = useState("");
  const [remindResolved, setRemindResolved] = useState<string | null>(null);
  const [remindFailed, setRemindFailed] = useState(false);
  const [eventTitle, setEventTitle] = useState("");
  const [eventWhen, setEventWhen] = useState("");
  const [eventLength, setEventLength] = useState("");
  const [eventReading, setEventReading] = useState<EventReading | null>(null);
  const [pickedFeedId, setEventFeedId] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A pick (or the host's preference) only counts while that calendar still takes new events.
  const preferredFeedId = options?.eventFeedId;
  const eventFeedId = useMemo(
    () => [pickedFeedId, preferredFeedId, writableFeeds[0]?.id].find((id) => !!id && writableFeeds.some((f) => f.id === id)) ?? null,
    [pickedFeedId, preferredFeedId, writableFeeds],
  );

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

  const previewEvent = async () => {
    setEventReading(await readEvent(eventWhen, eventLength, dates.parse));
  };

  const created = async (doc: DocRef) => {
    try {
      await onCreated.current?.(doc);
    } catch (err) {
      console.warn(`capture: the ${doc.kind} was saved, but the host's follow-up failed`, err);
    }
  };

  const saveNote = async () => {
    // The editor reports edits on a debounce, and at once on blur: blur it, so a save straight
    // after typing keeps the last words. (Web; the native WebView reports on its own clock.)
    if (Platform.OS === "web" && typeof document !== "undefined") {
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.(".ProseMirror")) active.blur();
    }
    const text = noteDraftRef.current.trim();
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

  const saveEvent = async (opts?: CaptureSubmitOptions) => {
    const title = eventTitle.trim();
    const feedId = opts?.feedId ?? eventFeedId;
    if (!title || !feedId || busy) return;
    setBusy(true);
    setEventError(null);
    const reading = await readEvent(eventWhen, eventLength, dates.parse);
    if (!reading.span) {
      setEventReading(reading.whenError || reading.lengthError ? reading : { ...reading, whenError: WHEN_MISSING });
      setBusy(false);
      return;
    }
    setEventReading(reading);
    try {
      await createEvent({ feedId, title, ...eventTimes(reading.span), location: null, description: null, repeat: null });
    } catch (err) {
      setEventError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    onEventCreated.current?.(localDay(reading.span.start));
    onClose();
  };

  const canSubmit =
    kind === "note"
      ? (noteTitle + noteDraft).trim().length > 0
      : kind === "task"
        ? taskTitle.trim().length > 0
        : eventTitle.trim().length > 0 && eventWhen.trim().length > 0 && !!eventFeedId;
  const submit = kind === "note" ? saveNote : kind === "task" ? saveTask : saveEvent;

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
      canCaptureEvents: writableFeeds.length > 0,
      eventTitle,
      setEventTitle,
      eventWhen,
      setEventWhen,
      eventWhenResolved: eventReading?.whenHint ?? null,
      eventWhenError: eventReading?.whenError ?? null,
      eventLength,
      setEventLength,
      eventLengthResolved: eventReading?.lengthHint ?? null,
      eventLengthError: eventReading?.lengthError ?? null,
      previewEvent,
      eventFeeds: writableFeeds,
      eventFeedId,
      setEventFeedId,
      eventError,
      busy,
      canSubmit,
      submit,
      linkSource,
      documentSource,
      linkRevision: tasks.tasks,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      kind,
      noteTitle,
      noteDraft,
      taskTitle,
      due,
      dueResolved,
      dueFailed,
      remind,
      remindResolved,
      remindFailed,
      eventTitle,
      eventWhen,
      eventLength,
      eventReading,
      writableFeeds,
      eventFeedId,
      eventError,
      busy,
      canSubmit,
      tasks.tasks,
      linkSource,
      documentSource,
    ],
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
