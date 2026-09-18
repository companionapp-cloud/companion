// The render_* tools (core/llm) ask the chat to show an entity inline instead of the assistant
// pasting it. This is the pure half: which tool call asks for which preview. Kept apart from the
// preview components so it carries no React Native.

/** The entity types render_graph can center a graph on. */
export type GraphRoot = "note" | "task" | "project" | "canvas";
const GRAPH_ROOTS: readonly string[] = ["note", "task", "project", "canvas"];

/** What a render_* tool call asks the chat to show inline. */
export type Preview =
  | { kind: "note" | "task" | "event" | "canvas"; id: string }
  | { kind: "graph"; type: GraphRoot; id: string; depth: number };

const RENDER_TOOLS: Record<string, "note" | "task" | "event" | "canvas"> = {
  render_note: "note",
  render_task: "task",
  render_event: "event",
  render_canvas: "canvas",
};

/** A tool call's arguments as an object. The built-in engine stores them as JSON; a CLI agent's
 *  (Claude Code, Codex) arrive as the JSON text the CLI reported, so that is parsed here. */
export function toolArgs(raw: unknown): Record<string, unknown> {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The preview a render_* tool call asks for; null for any other tool, or arguments that don't
 *  name an entity. */
export function previewOf(name: string, args: unknown): Preview | null {
  const a = toolArgs(args);
  const id = typeof a.id === "string" ? a.id.trim() : "";
  if (!id) return null;
  if (name === "render_graph") {
    const type = typeof a.type === "string" ? a.type : "";
    if (!GRAPH_ROOTS.includes(type)) return null;
    const depth = Math.min(3, Math.max(1, Math.round(Number(a.depth) || 2)));
    return { kind: "graph", type: type as GraphRoot, id, depth };
  }
  const kind = RENDER_TOOLS[name];
  return kind ? { kind, id } : null;
}
