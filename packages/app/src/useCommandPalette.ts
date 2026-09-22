import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarItem } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useProjects } from "./ProjectsProvider";
import { useCalendar } from "./CalendarProvider";
import { useCanvases } from "./canvas/CanvasesProvider";
import { useCaptureController, type CaptureController } from "./useCaptureController";
import { useProjectCalendars } from "./useProjectCalendars";
import type { ContainerRef, DocRef, TabRef } from "./nav-context";
import {
  dayBounds,
  eventsOnDay,
  findByDate,
  findByTitle,
  isDateScope,
  localDay,
  rootItems,
  type PaletteData,
  type PaletteItem,
  type PaletteMode,
} from "./paletteModel";

export interface CommandPaletteHost {
  /** Dismiss the palette (Esc at the root, after a capture, after opening a result). */
  onClose: () => void;
  /** Show a result in the app. The in-app overlay navigates; the quick-capture window asks the
   *  desktop shell to bring the main window forward on it. `newTab` (⇧⏎) asks for a tab of its
   *  own rather than the one already holding it, or the active one. */
  onOpen: (ref: TabRef, opts?: PaletteOpenOptions) => void;
  /** Open straight into a command — how New note / task / canvas / event (⌥⇧N / T / C / E, the
   *  File menu) skip the list. Read once, when the palette mounts. */
  initialMode?: PaletteMode;
  /** The project or area on screen, if any: what is created is filed there rather than left
   *  unsorted. The quick-capture window, which has no screen behind it, leaves it out. */
  container?: ContainerRef | null;
  /** Whether the new note's formatting bar offers to attach a file. The quick-capture window
   *  turns it off: a file picker takes focus from the panel, which dismisses it. Default on. */
  attachments?: boolean;
}

export interface PaletteOpenOptions {
  newTab?: boolean;
}

/** One chip at the foot of a new item: a project to file it in, or the calendar for an event. */
export interface PaletteChip {
  id: string;
  name: string;
  /** A project's emoji. */
  icon?: string | null;
  /** A calendar's colour. */
  color?: string | null;
}

/** The pick-one row of chips at the foot of a new item: "Which project?" for a task, note or
 *  canvas — optional, none leaves it unsorted — or "Which calendar?" for an event, which always
 *  has one. */
export interface PaletteChips {
  label: string;
  /** What a chip is, for the key hints. */
  noun: "project" | "calendar";
  choices: PaletteChip[];
  /** The chip picked (Space or a click), if any. */
  picked: string | null;
  /** One is always picked: Space on it leaves it picked. */
  required: boolean;
  /** Pick a chip — or unpick it, where none may be. */
  toggle: (id: string) => void;
}

export interface CommandPaletteController {
  mode: PaletteMode;
  query: string;
  setQuery: (q: string) => void;
  /** The rows on show; empty while filling in a new item. */
  items: PaletteItem[];
  selected: number;
  setSelected: (i: number) => void;
  move: (delta: number) => void;
  /** `newTab` opens a result in a tab of its own; a command ignores it. */
  run: (item: PaletteItem, newTab?: boolean) => void;
  /** ⏎: run the selected row, or save the new item. ⇧⏎ (`newTab`): open the row in a new tab,
   *  or save the new item and open *it* in one. */
  submit: (newTab?: boolean) => void;
  /** One step out: from a command to the list, from a query to empty. False at the bottom, where
   *  the host should close instead. */
  back: () => boolean;
  /** Why the list is empty, when it is. */
  emptyText: string | null;
  /** The due / reminder / body / when fields of the item being created. */
  capture: CaptureController;
  /** The chips under the new item's fields — the open projects, in sidebar order, or the
   *  calendars that take new events — when there is anything to choose. */
  chips: PaletteChips | null;
  /** The chip holding keyboard focus. ⏎ there saves the new item into *that* project or
   *  calendar — tabbing to a chip and saving is all it takes. */
  focusedChip: string | null;
  setFocusedChip: (id: string | null) => void;
  /** Where ⏎ would file a new task, note or canvas right now: the focused or picked project
   *  chip, else the project or area on screen. Null leaves it unsorted. */
  target: (ContainerRef & { name: string }) | null;
  /** The calendar ⏎ would add a new event to: the focused chip's, else the picked one. */
  calendarTarget: { id: string; name: string } | null;
  busy: boolean;
}

// How far title search looks for events. They are fetched once per palette, not per keystroke.
const EVENT_LOOKBACK_DAYS = 30;
const EVENT_LOOKAHEAD_DAYS = 365;
const UPCOMING_DAYS = 14;

/** State and behaviour of the command palette (PLAN §6.4): a list of commands that narrows as
 *  you type, find commands scoped to one kind of thing (by title, or by day), and create commands
 *  that turn the input into the new item's title. Presentation lives in CommandPalette. */
export function useCommandPalette({ onClose, onOpen, initialMode, container = null }: CommandPaletteHost): CommandPaletteController {
  const { calendar, dates } = useCore();
  const notes = useNotes();
  const tasks = useTasks();
  const projects = useProjects();
  const canvases = useCanvases();
  const { writableFeeds } = useCalendar();

  // --- where the new item goes: the chips at its foot ----------------------------------------
  const [projectId, setProjectId] = useState<string | null>(null);
  const [focusedChip, setFocusedChip] = useState<string | null>(null);
  const [mode, setModeState] = useState<PaletteMode>({ kind: "root" });
  // A new task, note or canvas goes where its chips say — the project on screen starts out
  // picked, and can be unpicked. An area is never a chip, so one on screen is where it goes. An
  // event isn't filed at all: its chips are calendars (below).
  const filing = mode.kind === "create" && mode.what !== "event";
  const chipProjectId = filing ? (focusedChip ?? projectId) : null;
  const targetContainer = useMemo<ContainerRef | null>(() => {
    if (!filing) return null;
    if (chipProjectId) return { kind: "project", id: chipProjectId };
    return container?.kind === "project" ? null : container;
  }, [filing, chipProjectId, container]);
  // Read when the save lands, by which time this render's closure is history.
  const targetRef = useRef(targetContainer);
  targetRef.current = targetContainer;
  const { addMember, addAreaMember } = projects;
  const file = useCallback(
    async (doc: DocRef) => {
      const to = targetRef.current;
      if (!to) return;
      try {
        if (to.kind === "project") await addMember(to.id, doc.kind, doc.id);
        else await addAreaMember(to.id, doc.kind, doc.id);
      } catch (err) {
        console.warn(`palette: the ${doc.kind} was saved, but not filed`, err);
      }
    },
    [addMember, addAreaMember],
  );
  // ⇧⏎ on a new task, note or event: set as the save starts, read when it lands. An event has no
  // page of its own; it opens the calendar on its week, as finding one does.
  const openCreated = useRef(false);
  const onCreated = useCallback(
    async (doc: DocRef) => {
      await file(doc);
      if (openCreated.current) onOpen(doc, { newTab: true });
    },
    [file, onOpen],
  );
  const onEventCreated = useCallback(
    (day: string) => {
      if (openCreated.current) onOpen({ kind: "view", view: "calendar", date: day }, { newTab: true });
    },
    [onOpen],
  );
  // A new event starts out in a calendar the project on screen holds, where there is one — so it
  // shows on that project's calendar — until another is picked.
  const shownCalendars = useProjectCalendars(container?.kind === "project" ? container.id : null);
  const capture = useCaptureController(onClose, { onCreated, onEventCreated, eventFeedId: shownCalendars.writableFeeds[0]?.id ?? null });
  const projectChoices = useMemo<PaletteChip[]>(() => {
    const areaOrder = new Map(projects.areas.map((a) => [a.id, a.sortOrder]));
    return projects.projects
      .filter((p) => !p.archivedAt && !p.deletedAt)
      .sort((a, b) => (areaOrder.get(a.areaId) ?? 0) - (areaOrder.get(b.areaId) ?? 0) || a.sortOrder - b.sortOrder)
      .map((p) => ({ id: p.id, name: p.name.trim() || "Untitled project", icon: p.icon }));
  }, [projects.projects, projects.areas]);
  const target = useMemo(() => {
    if (!targetContainer) return null;
    const { kind, id } = targetContainer;
    const held = kind === "project" ? [...projects.projects, ...projects.completedProjects].find((p) => p.id === id) : projects.areas.find((a) => a.id === id);
    return { kind, id, name: held?.name.trim() || (kind === "project" ? "Untitled project" : "Untitled area") };
  }, [targetContainer, projects.projects, projects.completedProjects, projects.areas]);
  const toggleProject = useCallback((id: string) => setProjectId((cur) => (cur === id ? null : id)), []);
  const { eventFeedId, setEventFeedId } = capture;
  const chips = useMemo<PaletteChips | null>(() => {
    if (mode.kind !== "create") return null;
    if (mode.what === "event") {
      // One calendar is no choice: the key hints say where it goes.
      if (writableFeeds.length < 2) return null;
      const choices = writableFeeds.map((f) => ({ id: f.id, name: f.name.trim() || "Untitled calendar", color: f.color }));
      return { label: "Which calendar?", noun: "calendar", choices, picked: eventFeedId, required: true, toggle: setEventFeedId };
    }
    if (projectChoices.length === 0) return null;
    return { label: "Which project?", noun: "project", choices: projectChoices, picked: projectId, required: false, toggle: toggleProject };
  }, [mode, writableFeeds, eventFeedId, setEventFeedId, projectChoices, projectId, toggleProject]);
  const calendarTarget = useMemo(() => {
    if (mode.kind !== "create" || mode.what !== "event") return null;
    const feed = writableFeeds.find((f) => f.id === (focusedChip ?? eventFeedId));
    return feed ? { id: feed.id, name: feed.name.trim() || "Untitled calendar" } : null;
  }, [mode, writableFeeds, focusedChip, eventFeedId]);

  const [query, setQueryState] = useState("");
  const [selected, setSelected] = useState(0);
  const [creating, setCreating] = useState(false);

  // While creating, the input is the new item's title: mirror it into the capture controller,
  // which owns the save.
  const { setKind, setTaskTitle, setNoteTitle, setEventTitle } = capture;
  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      setSelected(0);
      if (mode.kind !== "create") return;
      if (mode.what === "task") setTaskTitle(q);
      else if (mode.what === "note") setNoteTitle(q);
      else if (mode.what === "event") setEventTitle(q);
    },
    [mode, setTaskTitle, setNoteTitle, setEventTitle],
  );
  const enter = useCallback(
    (next: PaletteMode, seed = "") => {
      setModeState(next);
      setQueryState(seed);
      setSelected(0);
      setProjectId(next.kind === "create" && next.what !== "event" && container?.kind === "project" ? container.id : null);
      setFocusedChip(null);
      if (next.kind !== "create") return;
      if (next.what === "task") {
        setKind("task");
        setTaskTitle(seed);
      } else if (next.what === "note") {
        setKind("note");
        setNoteTitle(seed);
      } else if (next.what === "event") {
        setKind("event");
        setEventTitle(seed);
      }
    },
    [setKind, setTaskTitle, setNoteTitle, setEventTitle, container],
  );
  // Opened on a command (see `initialMode`): step into it once.
  const entered = useRef(false);
  useEffect(() => {
    if (entered.current || !initialMode) return;
    entered.current = true;
    enter(initialMode);
  }, [initialMode, enter]);

  // --- events, for title search: one wide window, fetched when first needed ----------------
  const [events, setEvents] = useState<CalendarItem[]>([]);
  const eventsRequested = useRef(false);
  const wantsEvents = mode.kind === "find" ? mode.scope === "event" || mode.scope === "all" : mode.kind === "root" && query.trim().length > 0;
  useEffect(() => {
    if (!wantsEvents || eventsRequested.current) return;
    eventsRequested.current = true;
    const now = Date.now();
    const day = 86_400_000;
    void calendar
      .range(new Date(now - EVENT_LOOKBACK_DAYS * day).toISOString(), new Date(now + EVENT_LOOKAHEAD_DAYS * day).toISOString())
      .then((items) => setEvents((items ?? []).filter((i) => i.kind === "event")))
      .catch(() => {
        eventsRequested.current = false;
      });
  }, [wantsEvents, calendar]);

  // --- the day a date scope is asking about ------------------------------------------------
  const dateScope = mode.kind === "find" && isDateScope(mode.scope);
  const [day, setDay] = useState<string | null>(null);
  const [dayFailed, setDayFailed] = useState(false);
  useEffect(() => {
    setDay(null);
    setDayFailed(false);
    const text = query.trim();
    if (!dateScope || !text) return;
    let stale = false;
    const t = setTimeout(() => {
      void dates
        .parse(text)
        .then((parsed) => {
          if (stale) return;
          setDay(parsed ? localDay(new Date(parsed.at)) : null);
          setDayFailed(!parsed);
        })
        .catch(() => {
          if (!stale) setDayFailed(true);
        });
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [dateScope, query, dates]);

  // A day's events (or, with nothing typed, the next two weeks').
  const eventDateScope = mode.kind === "find" && mode.scope === "eventDate";
  const [dayEvents, setDayEvents] = useState<CalendarItem[]>([]);
  const typedDay = query.trim().length > 0;
  useEffect(() => {
    if (!eventDateScope) return;
    if (typedDay && !day) {
      setDayEvents([]);
      return;
    }
    let stale = false;
    const now = new Date();
    const window = day ? dayBounds(day) : { from: now.toISOString(), to: new Date(now.getTime() + UPCOMING_DAYS * 86_400_000).toISOString() };
    void calendar
      .range(window.from, window.to)
      .then((items) => {
        if (!stale) setDayEvents(items ?? []);
      })
      .catch(() => {
        if (!stale) setDayEvents([]);
      });
    return () => {
      stale = true;
    };
  }, [eventDateScope, typedDay, day, calendar]);

  // --- rows ---------------------------------------------------------------------------------
  const data = useMemo<PaletteData>(
    () => ({ notes: notes.notes, tasks: tasks.tasks, canvases: canvases.canvases, projects: [...projects.projects, ...projects.completedProjects], areas: projects.areas }),
    [notes.notes, tasks.tasks, canvases.canvases, projects.projects, projects.completedProjects, projects.areas],
  );
  const canCreateEvent = writableFeeds.length > 0;
  const items = useMemo<PaletteItem[]>(() => {
    if (mode.kind === "root") return rootItems(query, data, events, { canCreateEvent });
    if (mode.kind === "create") return [];
    if (mode.scope === "eventDate") return eventsOnDay(dayEvents, day);
    if (mode.scope === "taskDate" || mode.scope === "projectDate") return typedDay && !day ? [] : findByDate(mode.scope, day, data);
    return findByTitle(mode.scope, query, data, events);
  }, [mode, query, data, events, dayEvents, day, typedDay, canCreateEvent]);

  const emptyText =
    mode.kind === "create" || items.length > 0
      ? null
      : dateScope && dayFailed
        ? "Couldn’t read a day — try “next friday”."
        : dateScope && typedDay && !day
          ? null // still parsing
          : dateScope
            ? "Nothing on that day."
            : query.trim()
              ? "Nothing matches."
              : "Nothing here yet.";

  // --- actions ------------------------------------------------------------------------------
  const run = useCallback(
    (item: PaletteItem, newTab = false) => {
      if (item.action.type === "mode") {
        enter(item.action.mode, item.action.seed);
        return;
      }
      onOpen(item.action.ref, { newTab });
      onClose();
    },
    [enter, onOpen, onClose],
  );

  // A canvas has no fields to capture and is nothing until it is drawn on: create it and open it.
  const createCanvas = useCallback(async (newTab: boolean) => {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const canvas = await canvases.create(name);
      await file({ kind: "canvas", id: canvas.id });
      onOpen({ kind: "canvas", id: canvas.id }, { newTab });
      onClose();
    } finally {
      setCreating(false);
    }
  }, [query, creating, canvases, file, onOpen, onClose]);

  const { canSubmit, busy: captureBusy, submit: captureSubmit } = capture;
  const submit = useCallback((newTab = false) => {
    if (mode.kind === "create") {
      if (mode.what === "canvas") void createCanvas(newTab);
      else if (canSubmit && !captureBusy) {
        openCreated.current = newTab;
        // ⏎ on a focused calendar chip adds the event there (a project chip files through `target`).
        void captureSubmit(mode.what === "event" && focusedChip ? { feedId: focusedChip } : undefined);
      }
      return;
    }
    const item = items[selected];
    if (item) run(item, newTab);
  }, [mode, createCanvas, canSubmit, captureBusy, captureSubmit, focusedChip, items, selected, run]);

  const move = useCallback(
    (delta: number) => setSelected((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length)),
    [items.length],
  );

  const back = useCallback(() => {
    if (mode.kind !== "root") {
      enter({ kind: "root" });
      return true;
    }
    if (query) {
      setQueryState("");
      setSelected(0);
      return true;
    }
    return false;
  }, [mode, query, enter]);

  return {
    mode,
    query,
    setQuery,
    items,
    selected: Math.min(selected, Math.max(0, items.length - 1)),
    setSelected,
    move,
    run,
    submit,
    back,
    emptyText,
    capture,
    chips,
    focusedChip,
    setFocusedChip,
    target,
    calendarTarget,
    busy: creating || captureBusy,
  };
}
