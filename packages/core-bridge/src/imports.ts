import type { CoreBridge } from "./types";

/** Where a Things library comes from (mirrors core/bridge importSource, PLAN §6.12): a path on
 *  this device (desktop, mobile), or files the web shell staged with `CoreBridge.stageFile`. */
export interface ImportSource {
  path?: string;
  files?: { handle: string; name: string }[];
}

/** A container's to-dos: open ones (Someday included), finished ones (the Logbook, imported only
 *  on request), and repeating ones. */
export interface ImportCounts {
  tasks: number;
  completed: number;
  repeating: number;
}

/** A Things project as a scan found it. `finished` marks one completed or canceled in Things;
 *  `repeats` the newest copy of a repeating project, which keeps repeating once imported. */
export interface ThingsProjectOutline extends ImportCounts {
  id: string;
  name: string;
  finished: boolean;
  repeats: boolean;
  headings: number;
}

/** A Things area as a scan found it: its own to-dos (the counts), and its projects. */
export interface ThingsAreaOutline extends ImportCounts {
  id: string;
  name: string;
  projects: ThingsProjectOutline[];
}

/** What a scan found, for the user to choose from (mirrors importer/things.Preview). */
export interface ThingsPreview {
  version: number;
  inbox: ImportCounts;
  areas: ThingsAreaOutline[];
  /** Projects in no area — they import into a "Things" area. */
  noArea: ThingsProjectOutline[];
  tags: number;
  warnings: string[];
}

/** What to import: whole containers, never single to-dos. A chosen project brings its area. */
export interface ThingsSelection {
  inbox: boolean;
  areas: string[];
  projects: string[];
}

/** What a run created (mirrors importer/things.Summary). */
export interface ThingsSummary {
  areas: number;
  projects: number;
  lists: number;
  headings: number;
  tasks: number;
  repeating: number;
  /** How many of `projects` carry a repeat. */
  repeatingProjects: number;
  notes: number;
  warnings: string[];
  /** Stopped part-way; what was written stays. */
  cancelled: boolean;
}

/** An `import.progress` event. */
export interface ImportProgress {
  source: "things";
  stage: string;
  done: number;
  total: number;
}

/** Typed wrappers over the import.* core methods (PLAN §6.12). */
export function importsApi(core: CoreBridge) {
  return {
    /** Read a Things library and outline it — writes nothing. */
    thingsScan: (source: ImportSource) =>
      core.invoke<ThingsPreview>("import.thingsScan", { source, timeZone: localTimeZone() }),
    /** Import the chosen parts of a Things library, streaming `import.progress`. */
    thingsRun: (input: { source: ImportSource; includeCompleted: boolean; selection: ThingsSelection }) =>
      core.invoke<ThingsSummary>("import.thingsRun", { ...input, timeZone: localTimeZone() }),
    /** Stop the running import after its current batch. */
    cancel: () => core.invoke<{ ok: boolean }>("import.cancel"),
    onProgress: (cb: (p: ImportProgress) => void) => core.on("import.progress", (p) => cb(p as ImportProgress)),
  };
}

export type ImportsApi = ReturnType<typeof importsApi>;

/** The user's IANA zone: Things' dates are wall-clock dates, and the web core's own local
 *  zone has no daylight saving. */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}
