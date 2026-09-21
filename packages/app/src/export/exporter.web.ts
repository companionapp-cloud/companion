import type { CanvasesApi, GraphApi, Note, NotesApi, ObjectTypesApi, ProjectsApi, Task, TasksApi } from "@companion/core-bridge";
import type { DocumentSource } from "@companion/editor";
import { markdownToHtml, markdownToText, portableMarkdown, type MarkdownExportOptions } from "@companion/editor/export";
import { reminderLabel } from "../reminders";
import { repeatLabel } from "../repeat";
import { frontmatter, yamlDate, type FrontmatterValue } from "./frontmatter";
import { canvasPage, notePage, standaloneHtml, taskFacts, taskPage, type ExportPage } from "./pages";
import { renderPdf, renderPng } from "./raster";
import type { ExportFormat, ExportTarget } from "./types";

// Turning a note, a task or a canvas into a file's bytes. DOM-only — it parses markdown with the
// editor's ProseMirror schema and draws PDFs and PNGs with the browser — so this is the web and
// desktop build; native resolves exporter.ts, which offers nothing yet.

/** The slices of the core an export reads, plus the platform's document bytes. */
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

export const canExport = (): boolean => typeof document !== "undefined";

const encode = (text: string) => new TextEncoder().encode(text);

function markdownOptions(deps: ExportDeps): MarkdownExportOptions {
  return {
    resolveLink: async (_type, id) => (await deps.graph.lookup(id))?.title ?? null,
    resolveDocument: deps.documentSource ? (id) => deps.documentSource!.resolveUrl(id) : undefined,
  };
}

/** The project or area a note or task is filed in, by name. */
async function filedIn(deps: ExportDeps, kind: "note" | "task", id: string): Promise<string | null> {
  const member = (await deps.projects.membershipsFor(kind, id).catch(() => []))[0];
  if (!member) return null;
  if (member.containerType === "area") return (await deps.projects.listAreas()).find((a) => a.id === member.projectId)?.name ?? null;
  return (await deps.projects.listProjects()).find((p) => p.id === member.projectId)?.name ?? null;
}

async function blobDataUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** The plain-text export's header: the facts as "Key: value" lines. */
const factLines = (facts: [string, string][]) => facts.map(([k, v]) => `${k}: ${v}`).join("\n");

/** An archetyped note's or task's type and properties (PLAN §6.3) as frontmatter fields, keyed as
 *  its schema keys them. A reference reads as its target's title; a field whose key would shadow
 *  one of the document's own fields is left out by `frontmatter` (first key wins). */
async function archetypeFields(deps: ExportDeps, item: Pick<Note | Task, "objectTypeId" | "props">): Promise<[string, FrontmatterValue][]> {
  if (!item.objectTypeId) return [];
  const type = await deps.objectTypes.get(item.objectTypeId).catch(() => null);
  if (!type) return [];
  const out: [string, FrontmatterValue][] = [["type", type.name]];
  for (const field of type.schemaJson?.fields ?? []) {
    const raw = item.props?.[field.key];
    if (raw === null || raw === undefined || raw === "") continue;
    const values = await Promise.all(
      (Array.isArray(raw) ? raw : [raw]).map(async (v) => {
        if (field.type === "reference" && typeof v === "string") return (await deps.graph.lookup(v).catch(() => null))?.title ?? v;
        return v;
      }),
    );
    if (Array.isArray(raw)) out.push([field.key, values.map(String)]);
    else if (typeof values[0] === "number" || typeof values[0] === "boolean") out.push([field.key, values[0]]);
    else out.push([field.key, field.type === "date" ? (yamlDate(String(values[0])) ?? String(values[0])) : String(values[0])]);
  }
  return out;
}

async function picture(page: ExportPage, format: "pdf" | "png"): Promise<Uint8Array> {
  return format === "pdf" ? renderPdf(page) : renderPng(page);
}

export async function renderExport(deps: ExportDeps, target: ExportTarget, format: ExportFormat): Promise<RenderedExport> {
  const md = markdownOptions(deps);

  if (target.kind === "canvas") {
    if (format !== "pdf" && format !== "png") throw new Error("A canvas exports as a PDF or a PNG.");
    const doc = await deps.canvases.get(target.id);
    const images = new Map<string, string>();
    await Promise.all(
      doc.nodes
        .filter((n) => n.kind === "image" && n.refId)
        .map(async (n) => {
          const res = await deps.documentSource?.resolveUrl(n.refId!).catch(() => null);
          const data = res ? await blobDataUrl(res.url) : null;
          if (data) images.set(n.refId!, data);
        }),
    );
    const page = canvasPage(doc, images);
    return { title: page.title, data: await picture(page, format) };
  }

  if (target.kind === "note") {
    const note = await deps.notes.get(target.id);
    const title = note.title || "Untitled";
    switch (format) {
      case "md": {
        const head = frontmatter([
          ["title", title],
          ["date", note.date],
          ["created", note.createdAt],
          ["updated", note.updatedAt],
          ["filed_in", await filedIn(deps, "note", note.id)],
          ...(await archetypeFields(deps, note)),
        ]);
        return { title, data: encode(`${head}${(await portableMarkdown(note.contentMd, md)).trim()}\n`) };
      }
      case "txt":
        return { title, data: encode(`${title}\n\n${await markdownToText(note.contentMd, md)}`) };
      default: {
        const page = notePage(note, await markdownToHtml(note.contentMd, md));
        return { title, data: format === "html" ? encode(standaloneHtml(page)) : await picture(page, format) };
      }
    }
  }

  const task = await deps.tasks.get(target.id);
  const title = task.title || "Untitled task";
  const where = await filedIn(deps, "task", task.id);
  const facts = taskFacts(task, where);
  switch (format) {
    case "md": {
      const head = frontmatter([
        ["title", title],
        ["status", task.status],
        ["start", task.someday ? "someday" : yamlDate(task.startAt)],
        ["deadline", yamlDate(task.dueAt)],
        ["repeat", repeatLabel(task.repeatRule)],
        ["reminders", (task.reminders ?? []).map((r) => (r.at ? (yamlDate(r.at) ?? r.at) : reminderLabel(r))).filter(Boolean)],
        ["completed", yamlDate(task.completedAt)],
        ["created", task.createdAt],
        ["updated", task.updatedAt],
        ["filed_in", where],
        ...(await archetypeFields(deps, task)),
      ]);
      const notes = (await portableMarkdown(task.notesMd, md)).trim();
      return { title, data: encode(`${head}${notes ? `${notes}\n` : ""}`) };
    }
    case "txt": {
      const notes = task.notesMd.trim() ? await markdownToText(task.notesMd, md) : "";
      return { title, data: encode(`${title}\n\n${factLines(facts)}\n${notes ? `\n${notes}` : ""}`) };
    }
    default: {
      const page = taskPage(task, where, task.notesMd.trim() ? await markdownToHtml(task.notesMd, md) : "");
      return { title, data: format === "html" ? encode(standaloneHtml(page)) : await picture(page, format) };
    }
  }
}
