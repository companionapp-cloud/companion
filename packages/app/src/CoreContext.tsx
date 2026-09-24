import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  aiApi,
  agentsApi,
  devicesApi,
  calendarApi,
  oauthApi,
  canvasesApi,
  chatsApi,
  dataApi,
  datesApi,
  graphApi,
  importsApi,
  listsApi,
  llmApi,
  notesApi,
  noteInkApi,
  exportsApi,
  importFilesApi,
  notifyApi,
  objectTypesApi,
  onboardingApi,
  pomodoroApi,
  projectsApi,
  tasksApi,
  trashApi,
  type AiApi,
  type AgentsApi,
  type DevicesApi,
  type CalendarApi,
  type OAuthApi,
  type CanvasesApi,
  type ChatsApi,
  type CoreBridge,
  type DataApi,
  type DatesApi,
  type GraphApi,
  type ImportsApi,
  type ListsApi,
  type LlmApi,
  type NotesApi,
  type NoteInkApi,
  type ExportsApi,
  type ImportFilesApi,
  type NotifyApi,
  type ObjectTypesApi,
  type OnboardingApi,
  type PomodoroApi,
  type ProjectsApi,
  type TasksApi,
  type TrashApi,
} from "@companion/core-bridge";

interface CoreValue {
  core: CoreBridge;
  notes: NotesApi;
  tasks: TasksApi;
  graph: GraphApi;
  projects: ProjectsApi;
  lists: ListsApi;
  imports: ImportsApi;
  objectTypes: ObjectTypesApi;
  trash: TrashApi;
  notify: NotifyApi;
  dates: DatesApi;
  llm: LlmApi;
  agents: AgentsApi;
  /** The note editor's one-shot writing assists (core/bridge/ai.go). */
  ai: AiApi;
  devices: DevicesApi;
  chats: ChatsApi;
  calendar: CalendarApi;
  /** OAuth sign-in flows (Google). Generic: calendar accounts today, app login later. */
  oauth: OAuthApi;
  canvases: CanvasesApi;
  /** Ink groups drawn over notes (PLAN-drawing.md). */
  noteInk: NoteInkApi;
  /** This device's scheduled folder and Git exports (core/export). */
  exports: ExportsApi;
  /** One-time import of a folder of markdown and canvas files. */
  importFiles: ImportFilesApi;
  /** Which guided tours the user has finished or skipped (synced). */
  onboarding: OnboardingApi;
  /** Timed focus sessions on tasks (synced; the timer itself is a desktop surface). */
  pomodoro: PomodoroApi;
  /** Counts and permanent clears behind Settings › Danger Zone. */
  data: DataApi;
}

const CoreCtx = createContext<CoreValue | null>(null);

/** CoreProvider makes a platform-supplied CoreBridge available to the UI tree. */
export function CoreProvider({ core, children }: { core: CoreBridge; children: ReactNode }) {
  const value = useMemo<CoreValue>(
    () => ({
      core,
      notes: notesApi(core),
      tasks: tasksApi(core),
      graph: graphApi(core),
      projects: projectsApi(core),
      lists: listsApi(core),
      imports: importsApi(core),
      objectTypes: objectTypesApi(core),
      trash: trashApi(core),
      notify: notifyApi(core),
      dates: datesApi(core),
      llm: llmApi(core),
      agents: agentsApi(core),
      ai: aiApi(core),
      devices: devicesApi(core),
      chats: chatsApi(core),
      calendar: calendarApi(core),
      oauth: oauthApi(core),
      canvases: canvasesApi(core),
      noteInk: noteInkApi(core),
      exports: exportsApi(core),
      importFiles: importFilesApi(core),
      onboarding: onboardingApi(core),
      pomodoro: pomodoroApi(core),
      data: dataApi(core),
    }),
    [core],
  );
  return <CoreCtx.Provider value={value}>{children}</CoreCtx.Provider>;
}

export function useCore(): CoreValue {
  const v = useContext(CoreCtx);
  if (!v) throw new Error("useCore must be used within a CoreProvider");
  return v;
}
