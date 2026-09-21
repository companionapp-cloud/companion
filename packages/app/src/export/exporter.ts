import type { CanvasesApi, GraphApi, NotesApi, ObjectTypesApi, ProjectsApi, TasksApi } from "@companion/core-bridge";
import type { DocumentSource } from "@companion/editor";
import type { ExportFormat, ExportTarget } from "./types";

// Native build of the exporter. Exports are drawn and parsed with the DOM (exporter.web.ts),
// which the phone shells don't have, so nothing is offered there yet: `canExport` keeps every
// export control out of the UI.

export interface ExportDeps {
  notes: NotesApi;
  tasks: TasksApi;
  canvases: CanvasesApi;
  graph: GraphApi;
  projects: ProjectsApi;
  objectTypes: ObjectTypesApi;
  documentSource?: DocumentSource;
}

export interface RenderedExport {
  title: string;
  data: Uint8Array;
}

export const canExport = (): boolean => false;

export async function renderExport(_deps: ExportDeps, _target: ExportTarget, _format: ExportFormat): Promise<RenderedExport> {
  throw new Error("Export isn’t available on this device yet.");
}
