import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarItem, Task } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useProjects } from "./ProjectsProvider";
import { useCanvases } from "./canvas/CanvasesProvider";
import { useCaptureController, type CaptureController } from "./useCaptureController";
import type { TabRef } from "./nav-context";
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
   *  desktop shell to bring the main window forward on it. */
  onOpen: (ref: TabRef) => void;
}

export interface PaletteProject {
  id: string;
  name: string;
  icon?: string | null;
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
  run: (item: PaletteItem) => void;
  /** ⏎: run the selected row, or save the new item. */
  submit: () => void;
  /** One step out: from a command to the list, from a query to empty. False at the bottom, where
   *  the host should close instead. */
  back: () => boolean;
  /** Why the list is empty, when it is. */
  emptyText: string | null;
  /** The due / reminder / body fields of the item being created. */
  capture: CaptureController;
  /** Where a new task can be filed: the open projects, in sidebar order. */
  projectChoices: PaletteProject[];
  /** The project picked for the new task (Space or a click on its chip), if any. */
  projectId: string | null;
  toggleProject: (id: string) => void;
  /** The chip holding keyboard focus. ⏎ there files the task in *that* project — tabbing to a
   *  chip and saving is all it takes. */
  focusedProjectId: string | null;
  setFocusedProject: (id: string | null) => void;
  /** The project ⏎ would file the task in right now. */
  targetProject: PaletteProject | null;
  busy: boolean;
}

// How far title search looks for events. They are fetched once per palette, not per keystroke.
const EVENT_LOOKBACK_DAYS = 30;
const EVENT_LOOKAHEAD_DAYS = 365;
const UPCOMING_DAYS = 14;

/** State and behaviour of the command palette (PLAN §6.4): a list of commands that narrows as
 *  you type, find commands scoped to one kind of thing (by title, or by day), and create commands
 *  that turn the input into the new item's title. Presentation lives in CommandPalette. */
export function useCommandPalette({ onClose, onOpen }: CommandPaletteHost): CommandPaletteController {
  const { calendar, dates } = useCore();
  const notes = useNotes();
  const tasks = useTasks();
  const projects = useProjects();
  const canvases = useCanvases();

  // --- the new task's project ---------------------------------------------------------------
  const [projectId, setProjectId] = useState<string | null>(null);
  const [focusedProjectId, setFocusedProject] = useState<string | null>(null);
  const targetProjectId = focusedProjectId ?? projectId;
  // Read when the save lands, by which time this render's closure is history.
  const targetRef = useRef(targetProjectId);
  targetRef.current = targetProjectId;
  const { addMember } = projects;
  const onTaskCreated = useCallback(
    async (task: Task) => {
      if (targetRef.current) await addMember(targetRef.current, "task", task.id);
    },
    [addMember],
  );
  const capture = useCaptureController(onClose, { onTaskCreated });
  const projectChoices = useMemo<PaletteProject[]>(() => {
    const areaOrder = new Map(projects.areas.map((a) => [a.id, a.sortOrder]));
    return projects.projects
      .filter((p) => !p.archivedAt && !p.deletedAt)
      .sort((a, b) => (areaOrder.get(a.areaId) ?? 0) - (areaOrder.get(b.areaId) ?? 0) || a.sortOrder - b.sortOrder)
      .map((p) => ({ id: p.id, name: p.name.trim() || "Untitled project", icon: p.icon }));
  }, [projects.projects, projects.areas]);
  const toggleProject = useCallback((id: string) => setProjectId((cur) => (cur === id ? null : id)), []);

  const [mode, setModeState] = useState<PaletteMode>({ kind: "root" });
  const [query, setQueryState] = useState("");
  const [selected, setSelected] = useState(0);
  const [creating, setCreating] = useState(false);

  // While creating, the input is the new item's title: mirror it into the capture controller,
  // which owns the save.
  const { setKind, setTaskTitle, setNoteTitle } = capture;
  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      setSelected(0);
      if (mode.kind !== "create") return;
      if (mode.what === "task") setTaskTitle(q);
      else if (mode.what === "note") setNoteTitle(q);
    },
    [mode, setTaskTitle, setNoteTitle],
  );
  const enter = useCallback(
    (next: PaletteMode, seed = "") => {
      setModeState(next);
      setQueryState(seed);
      setSelected(0);
      setProjectId(null);
      setFocusedProject(null);
      if (next.kind !== "create") return;
      if (next.what === "task") {
        setKind("task");
        setTaskTitle(seed);
      } else if (next.what === "note") {
        setKind("note");
        setNoteTitle(seed);
      }
    },
    [setKind, setTaskTitle, setNoteTitle],
  );

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
  const items = useMemo<PaletteItem[]>(() => {
    if (mode.kind === "root") return rootItems(query, data, events);
    if (mode.kind === "create") return [];
    if (mode.scope === "eventDate") return eventsOnDay(dayEvents, day);
    if (mode.scope === "taskDate" || mode.scope === "projectDate") return typedDay && !day ? [] : findByDate(mode.scope, day, data);
    return findByTitle(mode.scope, query, data, events);
  }, [mode, query, data, events, dayEvents, day, typedDay]);

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
    (item: PaletteItem) => {
      if (item.action.type === "mode") {
        enter(item.action.mode, item.action.seed);
        return;
      }
      onOpen(item.action.ref);
      onClose();
    },
    [enter, onOpen, onClose],
  );

  // A canvas has no fields to capture and is nothing until it is drawn on: create it and open it.
  const createCanvas = useCallback(async () => {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const canvas = await canvases.create(name);
      onOpen({ kind: "canvas", id: canvas.id });
      onClose();
    } finally {
      setCreating(false);
    }
  }, [query, creating, canvases, onOpen, onClose]);

  const { canSubmit, busy: captureBusy, submit: captureSubmit } = capture;
  const submit = useCallback(() => {
    if (mode.kind === "create") {
      if (mode.what === "canvas") void createCanvas();
      else if (canSubmit && !captureBusy) void captureSubmit();
      return;
    }
    const item = items[selected];
    if (item) run(item);
  }, [mode, createCanvas, canSubmit, captureBusy, captureSubmit, items, selected, run]);

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
    projectChoices,
    projectId,
    toggleProject,
    focusedProjectId,
    setFocusedProject,
    targetProject: projectChoices.find((c) => c.id === targetProjectId) ?? null,
    busy: creating || captureBusy,
  };
}
