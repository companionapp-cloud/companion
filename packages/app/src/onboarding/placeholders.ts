import type { NotesStore } from "../NotesProvider";
import type { TasksStore } from "../TasksProvider";
import type { ProjectsStore } from "../ProjectsProvider";

// Placeholder content for the tours: a tool with nothing in it has nothing to point at, so the
// tour for an empty tool fills it with a few samples first. They are ordinary notes, tasks, an
// area and a project, written as a checklist of things to try, so they are worth keeping and
// easy to delete. They are only ever made when the tool is empty (or, for the area, when the
// user says yes), and at most once per session even if two tours ask.

let sampleTasks: Promise<string[]> | null = null;
let sampleNotes: Promise<string[]> | null = null;

const MINUTE = 60_000;

/** The sample tasks, unless the user already has tasks: returns the created ids, first the one
 *  the tasks tour opens. */
export function ensureSampleTasks(tasks: TasksStore): Promise<string[]> {
  if (tasks.tasks.length > 0 || tasks.seeds.length > 0) return Promise.resolve([]);
  if (!sampleTasks) {
    sampleTasks = createSampleTasks(tasks).catch((err) => {
      sampleTasks = null;
      throw err;
    });
  }
  return sampleTasks;
}

async function createSampleTasks(tasks: TasksStore): Promise<string[]> {
  // A half-hour block on today's agenda, starting at the next quarter hour (kept inside today).
  const now = new Date();
  const lastStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 15);
  const start = new Date(Math.min(Math.ceil(now.getTime() / (15 * MINUTE)) * 15 * MINUTE, lastStart.getTime()));
  const inTwoDays = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 17, 0);
  const created = [
    await tasks.create({
      title: "Write today’s note",
      notesMd: "Today opens on a fresh daily note. This task has a start and a deadline, so it shows as a block on Today’s agenda. Drag the block to move it.",
      startAt: start.toISOString(),
      dueAt: new Date(start.getTime() + 30 * MINUTE).toISOString(),
    }),
    await tasks.create({
      title: "Connect a calendar",
      notesMd: "Settings › Calendar adds iCloud, Fastmail, Google Calendar or any CalDAV calendar.",
      dueAt: inTwoDays.toISOString(),
    }),
    await tasks.create({
      title: "Link a note from a task",
      notesMd: "Type `[[` in a task’s notes to link a note or another task.",
    }),
  ];
  return created.map((t) => t.id);
}

/** The sample notes, unless the user already has notes (daily notes aside): returns the created
 *  ids, first the one the notes tour opens. */
export function ensureSampleNotes(notes: NotesStore): Promise<string[]> {
  if (notes.notes.some((n) => !n.date)) return Promise.resolve([]);
  if (!sampleNotes) {
    sampleNotes = createSampleNotes(notes).catch((err) => {
      sampleNotes = null;
      throw err;
    });
  }
  return sampleNotes;
}

async function createSampleNotes(notes: NotesStore): Promise<string[]> {
  const linked = await notes.create({
    title: "Ideas",
    contentMd: "This note is linked from Welcome to Companion. Links work both ways: open the graph from either note to see them.",
  });
  const welcome = await notes.create({
    title: "Welcome to Companion",
    contentMd: [
      "Notes are Markdown, formatted as you type.",
      "",
      "## Try it",
      "",
      "- Start a line with `##` for a heading, or `-` for a list",
      "- **Bold** and *italic* work the usual way",
      // A note chip shows its alias (the editor writes one when you pick a link), not a title.
      `- Type \`[[\` to link a note or a task, like this one: [[note:${linked.id}|${linked.title}]]`,
      "",
      "Press the pen in the toolbar to write or draw over the page.",
    ].join("\n"),
  });
  return [welcome.id, linked.id];
}

/** The sample area and a project inside it, with two starter tasks filed in the project. */
export async function createSampleArea(projects: ProjectsStore, tasks: TasksStore): Promise<{ areaId: string; projectId: string }> {
  const area = await projects.createArea({
    name: "Personal",
    icon: "🌱",
    descriptionMd: "An area is an ongoing part of your life. Everything in its projects rolls up to this page.",
  });
  const project = await projects.createProject({
    areaId: area.id,
    name: "Get started with Companion",
    icon: "🧭",
    descriptionMd: "A project has a finish line. Give each one an icon, a cover and a description like this one.",
  });
  for (const title of ["Add a cover to this project", "File a note in this project"]) {
    const task = await tasks.create({ title });
    await projects.addMember(project.id, "task", task.id);
  }
  return { areaId: area.id, projectId: project.id };
}
