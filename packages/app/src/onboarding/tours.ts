import type { NotesStore } from "../NotesProvider";
import type { TasksStore } from "../TasksProvider";
import type { ProjectsStore } from "../ProjectsProvider";
import { createSampleArea, ensureSampleNotes, ensureSampleTasks } from "./placeholders";
import { docsUrl } from "./links";
import type { Place, TourNav } from "./host";

// The tutorials (tours in code): one per tool, each shown the first time the user opens that
// tool, ending on its own page. A tutorial has one id and version on every device, so seeing it
// anywhere counts everywhere, and a plan per layout, because the desktop page and the phone
// screens put things in different places. Bump a tutorial's `version` when it changes enough that
// people who took it should see it again.
//
// Copy rules: short sentences, no em dashes.

export type TourId = "today" | "chat" | "calendar" | "notes" | "tasks" | "graph" | "areas" | "area" | "project";

const docs = (slug: string) => ({ label: "Read the docs", url: docsUrl(slug) });

/** What tutorials can reach while they run. The stores always read their latest value, so a
 *  tutorial that awaits (creating placeholder content, say) never works from a stale copy. */
export interface TourContext extends TourNav {
  readonly notes: NotesStore;
  readonly tasks: TasksStore;
  readonly projects: ProjectsStore;
  /** The note or task on screen, if any. */
  doc: () => { kind: "note" | "task"; id: string } | null;
  /** Resolves once `test` holds, or after `timeoutMs` regardless. */
  waitFor: (test: () => boolean, timeoutMs?: number) => Promise<boolean>;
  /** Scratch space for one run: what `prepare` picked, for a later step to open. */
  picked: { note?: string; task?: string };
}

export interface TourChoice {
  label: string;
  primary?: boolean;
  /** Runs when picked. On the last step the tutorial then ends, as completed. */
  run?: (ctx: TourContext) => Promise<void> | void;
}

export interface TourStep {
  /** The element (or elements) to spotlight; none shows the card in the middle of the window. */
  anchor?: string | readonly string[];
  title: string;
  body: string;
  link?: { label: string; url: string };
  /** Go somewhere before this step shows (a phone opens the note a list step talked about).
   *  Stepping back from it goes back again. */
  go?: (ctx: TourContext) => void;
  /** Desktop: hold the sidebar open while this step shows, because its anchor lives there. */
  rail?: boolean;
  /** A state the page must be in for this step, such as one side of a segmented page
   *  ("today.agenda"). The page shows it while the step is up, then goes back to its own
   *  (useTourView). */
  view?: string;
  /** Leave the step out when its anchor isn't on the page (a tool hidden in Settings, a page
   *  with no cover). Otherwise a missing anchor shows the card in the middle of the window. */
  optional?: boolean;
  /** Include the step only when this holds as the tutorial starts. */
  when?: (ctx: TourContext) => boolean;
  /** Buttons in place of Next. */
  choices?: readonly TourChoice[];
  /** A secondary button that ends the tutorial (as completed) and goes somewhere. */
  action?: { label: string; run: (ctx: TourContext) => void };
}

/** How a tutorial runs in one layout. */
export interface TourPlan {
  /** The pages it starts by itself on. "idle": any page the user opens that has no tutorial of
   *  its own left to show (never Settings, never the page the app opened on). */
  startsOn: readonly Place[] | "idle";
  /** The pages its steps visit; leaving them ends it. Defaults to `startsOn`. */
  runsOn?: readonly Place[];
  /** Wait for the user to move before starting, rather than greet them on the page the app
   *  opened on. */
  afterMoving?: boolean;
  /** Whether its page can be reached right now (an area page needs an area). */
  available?: (ctx: TourContext) => boolean;
  /** Go to its page, to replay it from Settings. */
  open: (ctx: TourContext) => void;
  /** Get the page ready: fill an empty tool with placeholder content, open a document. */
  prepare?: (ctx: TourContext) => Promise<void>;
  steps: readonly TourStep[];
}

export interface TourDef {
  id: TourId;
  version: number;
  /** Shown on the card and in Settings › Tutorials. */
  label: string;
  /** Not once this other tutorial is settled: it covered the same ground. */
  unless?: TourId;
  desktop: TourPlan;
  mobile: TourPlan;
}

/** The area a replay opens: the first there is. */
function firstArea(ctx: TourContext): string | null {
  return ctx.projects.sidebar.areas[0]?.id ?? null;
}

/** The project a replay opens: the first there is. */
function firstProject(ctx: TourContext): string | null {
  const { areas, unsorted } = ctx.projects.sidebar;
  return areas.flatMap((a) => a.projects).find((p) => !p.someday)?.id ?? unsorted[0]?.id ?? null;
}

/** The note a notes tutorial shows: a sample it just made, else the newest. */
async function pickNote(ctx: TourContext): Promise<string | undefined> {
  await ctx.waitFor(() => !ctx.notes.loading);
  const [sample] = await ensureSampleNotes(ctx.notes);
  return sample ?? ctx.notes.visible[0]?.id ?? ctx.notes.notes.find((n) => !n.date)?.id;
}

/** The task a tasks tutorial shows: a sample it just made, else the first open one. */
async function pickTask(ctx: TourContext): Promise<string | undefined> {
  await ctx.waitFor(() => !ctx.tasks.loading);
  const [sample] = await ensureSampleTasks(ctx.tasks);
  const open = (t: { status: string }) => t.status === "open";
  return sample ?? ctx.tasks.visible.find(open)?.id ?? ctx.tasks.tasks.find(open)?.id ?? ctx.tasks.tasks[0]?.id;
}

/** The agenda and calendar have something to show once there is a scheduled task. */
const withSampleTasks = async (ctx: TourContext) => {
  await ctx.waitFor(() => !ctx.tasks.loading);
  await ensureSampleTasks(ctx.tasks);
};

/** An empty workspace has an empty graph: a pair of linked sample notes gives it a shape. */
const withSampleGraph = async (ctx: TourContext) => {
  await ctx.waitFor(() => !ctx.notes.loading && !ctx.tasks.loading);
  if (ctx.notes.notes.length === 0 && ctx.tasks.tasks.length === 0) await ensureSampleNotes(ctx.notes);
};

// --- copy shared by both layouts ------------------------------------------------------------

const DAILY_NOTE = {
  title: "Your daily note",
  body: "Today opens on a fresh note for the day. Plans, meeting notes, loose thoughts: it all goes here, and it saves as you type.",
};
const CHAT = {
  title: "Chat with AI",
  body: "Ask about your workspace, or have AI draft tasks, notes, canvases and calendar events for you.",
};
const CHAT_AGENT = {
  title: "Bring your own AI",
  body: "Chat needs an agent: one the desktop app runs on your computer, like Claude Code or Ollama, or an API key for Anthropic or OpenAI.",
  link: docs("chatting-with-companion"),
};
const CALENDARS = {
  title: "Bring in your calendars",
  body: "Connect iCloud, Fastmail, Google Calendar or any CalDAV calendar in Settings.",
  link: docs("calendars"),
  action: { label: "Open settings", run: (ctx: TourContext) => ctx.openSettings("calendar") },
};
const NOTES = { title: "Notes", body: "Capture your thoughts as they come. Everything saves as you type." };
const MARKDOWN = {
  title: "Markdown and wikilinks",
  body: "Write in Markdown: ## for a heading, - for a list, **bold**. Type [[ to link another note or a task.",
};
const INK = { title: "Ink", body: "Write or draw right over the page, with a pen, a trackpad or a mouse." };
const INK_TOUCH = { title: "Ink", body: "Write or draw right over the page, with a finger or a pen." };
const NOTE_GRAPH = { title: "The note’s graph", body: "See what this note links to, and everything that links back to it." };
const FILTERS = { title: "Filters", body: "Switch between unsorted, anytime, upcoming, overdue and someday tasks, or see them all." };
const DATES = {
  title: "Start and deadline",
  body: "A start is when a task becomes something to work on. A deadline is when it is due. Set both to block out time on your calendar.",
};
const REMINDERS = {
  title: "Reminders",
  body: "Get a notification at a set time, or a while before the deadline.",
  link: docs("creating-and-linking-tasks"),
};
const GRAPH = {
  title: "How it all connects",
  body: "Every note, task and canvas, joined by the wikilinks between them and by the area or project each is filed in.",
  link: docs("using-the-graph"),
};
const AREAS = {
  title: "Areas and projects",
  body: "Areas are the ongoing parts of your life, like Work or Home. Projects sit inside them and have a finish line. File notes, tasks and canvases in either.",
  link: docs("your-first-project"),
};
const SAMPLE_AREA: Omit<TourStep, "anchor"> = {
  title: "Try one out?",
  body: "Add a sample area with a project in it. Open either to see how they fit together.",
  when: (ctx) => ctx.projects.sidebar.areas.length === 0,
  choices: [
    { label: "Not now" },
    {
      label: "Add sample area",
      primary: true,
      run: async (ctx) => {
        await ctx.waitFor(() => !ctx.tasks.loading);
        const { areaId } = await createSampleArea(ctx.projects, ctx.tasks);
        await ctx.waitFor(() => ctx.projects.sidebar.areas.some((a) => a.id === areaId));
      },
    },
  ],
};

/** An area's or a project's page: the same in every layout. Its sections sit in the desktop's
 *  chip row, the mobile web nav bar's segments, or the native tab bar, all anchored alike. */
function pageSteps(kind: "area" | "project"): TourStep[] {
  const steps: TourStep[] = [
    {
      anchor: ["page.cover", "page.icon"],
      title: "Icon and cover",
      body: `Give the ${kind} an emoji and a cover image. The emoji shows beside it wherever it is listed.`,
    },
    {
      anchor: "page.description",
      title: "Description",
      body:
        kind === "area"
          ? "Say what the area covers. It is a full editor, so you can link notes and tasks and add files."
          : "Say what the project is for and what done looks like. Link notes and tasks, add files.",
    },
    {
      anchor: "page.section.overview",
      optional: true,
      title: "Overview",
      body:
        kind === "area"
          ? "This page. The area’s projects, recent tasks, notes and canvases in one place."
          : "This page. The project’s schedule, tasks, notes and canvases at a glance.",
    },
  ];
  if (kind === "area") {
    steps.push(
      { anchor: "page.section.notes", optional: true, title: "Notes", body: "Every note filed in the area, and in its projects." },
      { anchor: "page.section.tasks", optional: true, title: "Tasks", body: "The area’s tasks and its projects’ tasks, with the same filters as the Tasks tool." },
      { anchor: "page.section.canvases", optional: true, title: "Canvases", body: "Boards filed in the area and in its projects." },
    );
  } else {
    steps.push(
      { anchor: "page.section.notes", optional: true, title: "Notes", body: "Notes filed in this project." },
      { anchor: "page.section.tasks", optional: true, title: "Tasks", body: "The project’s tasks, with the same filters as the Tasks tool." },
      { anchor: "page.section.lists", optional: true, title: "Lists", body: "Put the project’s tasks in order, under headings, to plan the work." },
      { anchor: "page.section.canvases", optional: true, title: "Canvases", body: "Boards for laying the project out visually." },
      { anchor: "page.section.calendars", optional: true, title: "Calendars", body: "Calendars filed in the project, beside its work." },
      { anchor: "page.section.habits", optional: true, title: "Habits", body: "Habits and streaks for the project. Coming soon." },
    );
  }
  return steps;
}

const areaPlan: TourPlan = {
  // Only an area's overview has a tutorial; its sections are the tools toured on their own.
  startsOn: ["area"],
  available: (ctx) => firstArea(ctx) !== null,
  open: (ctx) => {
    const id = firstArea(ctx);
    if (id) ctx.openArea(id);
  },
  steps: pageSteps("area"),
};

const projectPlan: TourPlan = {
  startsOn: ["project"],
  available: (ctx) => firstProject(ctx) !== null,
  open: (ctx) => {
    const id = firstProject(ctx);
    if (id) ctx.openProject(id);
  },
  steps: pageSteps("project"),
};

const graphPlan: TourPlan = {
  startsOn: ["graph"],
  open: (ctx) => ctx.go("graph"),
  prepare: withSampleGraph,
  steps: [{ anchor: "graph.canvas", ...GRAPH }],
};

export const TOURS: readonly TourDef[] = [
  {
    id: "today",
    version: 1,
    label: "Today",
    desktop: {
      startsOn: ["today"],
      open: (ctx) => ctx.go("today"),
      prepare: withSampleTasks,
      steps: [
        { anchor: "today.note", ...DAILY_NOTE },
        { anchor: "today.calendar", title: "One note per day", body: "Pick a day to read or write its note. A dot marks the days that have one." },
        {
          anchor: "today.agenda",
          title: "The day’s agenda",
          body: "Events and scheduled tasks for the day you picked. Click an empty slot to block out time for a task, or drag a block to move it.",
        },
      ],
    },
    mobile: {
      startsOn: ["today"],
      open: (ctx) => ctx.go("today"),
      prepare: withSampleTasks,
      // Today is two segments on a phone, the note and the agenda; each step shows its own.
      steps: [
        { anchor: "today.page", view: "today.note", ...DAILY_NOTE },
        {
          anchor: ["today.segment.agenda", "today.calendar"],
          view: "today.agenda",
          title: "One note per day",
          body: "Agenda holds the month. Pick a day to read or write its note. A dot marks the days that have one.",
        },
        {
          anchor: "today.agenda",
          view: "today.agenda",
          title: "The day’s agenda",
          body: "Events and scheduled tasks for the day you picked. Add a task to it right here.",
        },
      ],
    },
  },
  {
    id: "chat",
    version: 1,
    label: "Chat",
    desktop: {
      startsOn: ["chat"],
      open: (ctx) => ctx.go("chat"),
      steps: [
        { anchor: "chat.surface", ...CHAT },
        { anchor: "chat.setup", ...CHAT_AGENT },
      ],
    },
    mobile: {
      startsOn: ["chat"],
      open: (ctx) => ctx.go("chat"),
      steps: [
        { anchor: "chat.surface", ...CHAT },
        { ...CHAT_AGENT, action: { label: "Set up", run: (ctx) => ctx.openSettings("ai") } },
      ],
    },
  },
  {
    id: "calendar",
    version: 1,
    label: "Calendar",
    desktop: {
      startsOn: ["calendar"],
      open: (ctx) => ctx.go("calendar"),
      prepare: withSampleTasks,
      steps: [
        { anchor: "calendar.week", title: "Your week, top down", body: "Scheduled tasks, daily notes and calendar events, laid out by day and hour." },
        { anchor: "rail.settings", ...CALENDARS },
      ],
    },
    mobile: {
      startsOn: ["calendar"],
      open: (ctx) => ctx.go("calendar"),
      prepare: withSampleTasks,
      steps: [
        { anchor: "calendar.day", title: "Your days at a glance", body: "Pick a day to see its scheduled tasks, daily notes and calendar events." },
        CALENDARS,
      ],
    },
  },
  {
    id: "notes",
    version: 1,
    label: "Notes",
    desktop: {
      startsOn: ["notes"],
      open: (ctx) => ctx.go("notes"),
      // The editor steps need a note open: the one on screen, else a sample or the newest.
      prepare: async (ctx) => {
        if (ctx.doc()?.kind === "note") return;
        const id = await pickNote(ctx);
        if (id) ctx.openNote(id);
      },
      steps: [
        { anchor: "notes.list", ...NOTES },
        { anchor: "note.body", ...MARKDOWN },
        { anchor: "note.ink", ...INK },
        { anchor: "note.graph", ...NOTE_GRAPH },
      ],
    },
    mobile: {
      // The list and the editor are separate screens: it starts on the list, then opens a note.
      startsOn: ["notes"],
      runsOn: ["notes", "note"],
      open: (ctx) => ctx.go("notes"),
      prepare: async (ctx) => {
        ctx.picked.note = await pickNote(ctx);
      },
      steps: [
        { anchor: "notes.list", ...NOTES },
        {
          anchor: "note.body",
          ...MARKDOWN,
          go: (ctx) => {
            if (ctx.picked.note) ctx.openNote(ctx.picked.note);
          },
        },
        { anchor: "note.ink", ...INK_TOUCH },
        { anchor: "note.graph", ...NOTE_GRAPH },
      ],
    },
  },
  {
    id: "tasks",
    version: 1,
    label: "Tasks",
    desktop: {
      startsOn: ["tasks"],
      open: (ctx) => ctx.go("tasks"),
      // The date and reminder steps need a task open: the one on screen, else the first open one.
      prepare: async (ctx) => {
        if (ctx.doc()?.kind === "task") return;
        const id = await pickTask(ctx);
        if (id) ctx.openTask(id);
      },
      steps: [
        { anchor: "tasks.quickAdd", title: "Quick add", body: "Type a task and press Enter. It opens straight away, ready for details." },
        { anchor: "tasks.filters", ...FILTERS },
        { anchor: ["task.start", "task.deadline"], ...DATES },
        { anchor: "task.reminders", ...REMINDERS },
      ],
    },
    mobile: {
      startsOn: ["tasks"],
      runsOn: ["tasks", "task"],
      open: (ctx) => ctx.go("tasks"),
      prepare: async (ctx) => {
        ctx.picked.task = await pickTask(ctx);
      },
      steps: [
        { anchor: "tasks.new", title: "Quick add", body: "Tap + to add a task. It opens straight away, ready for details." },
        { anchor: "tasks.filters", ...FILTERS },
        {
          anchor: ["task.start", "task.deadline"],
          ...DATES,
          go: (ctx) => {
            if (ctx.picked.task) ctx.openTask(ctx.picked.task);
          },
        },
        { anchor: "task.reminders", ...REMINDERS },
      ],
    },
  },
  { id: "graph", version: 1, label: "Graph", desktop: graphPlan, mobile: graphPlan },
  {
    // Areas and projects: in the sidebar on the desktop, on Home on a phone.
    id: "areas",
    version: 1,
    label: "Areas & projects",
    unless: "area",
    desktop: {
      startsOn: "idle",
      open: () => undefined,
      steps: [
        { anchor: "sidebar.areas", rail: true, ...AREAS },
        { anchor: "sidebar.areas", rail: true, ...SAMPLE_AREA },
      ],
    },
    mobile: {
      startsOn: ["home"],
      afterMoving: true,
      open: (ctx) => ctx.go("home"),
      // Both on the areas block: it is where the sample lands, and it is already on screen (native
      // can't scroll an element into view the way the web does).
      steps: [
        { anchor: "home.areas", ...AREAS },
        { anchor: "home.areas", ...SAMPLE_AREA },
      ],
    },
  },
  { id: "area", version: 1, label: "Area page", desktop: areaPlan, mobile: areaPlan },
  { id: "project", version: 1, label: "Project page", desktop: projectPlan, mobile: projectPlan },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map((t) => [t.id, t])) as Record<TourId, TourDef>;

/** The anchor ids a step spotlights. */
export function stepAnchors(step: TourStep): readonly string[] {
  if (!step.anchor) return [];
  return typeof step.anchor === "string" ? [step.anchor] : step.anchor;
}
