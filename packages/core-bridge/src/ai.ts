import type { CoreBridge, ObjectProps } from "./types";

// Editor AI (core/bridge/ai.go): one-shot writing assists over a note or a selection of it.
// Nothing is persisted; a run streams `ai.delta` and ends with one `ai.done` or `ai.error`,
// each tagged with the caller-chosen run id. A cancelled run emits nothing more.

/** The assists the note editor offers. */
export type AiTask = "generate" | "readingLevel" | "grammar" | "summarize" | "translate" | "critique" | "metadata";

/** Whether the assists can run on this device, and on which agent. */
export interface AiStatus {
  enabled: boolean;
  /** Why not, when disabled (no agent, missing key, agent hosted elsewhere …). */
  reason?: string;
  agentId?: string;
  agentName?: string;
}

export interface AiRunInput {
  runId: string;
  task: AiTask;
  /** What the task acts on: the selection, or the whole note when nothing is selected. */
  text?: string;
  /** The whole note as context: with a selection, or (generate) with the cursor marked. */
  document?: string;
  title?: string;
  selection?: boolean;
  /** generate: the instruction. */
  prompt?: string;
  /** readingLevel: the target US grade (13–16 college, 17+ graduate). */
  grade?: number;
  /** translate: the target language, in words ("Spanish", "Brazilian Portuguese"). */
  language?: string;
  /** metadata: the entity's current type; omit to let the model pick one. */
  objectTypeId?: string | null;
  kind?: "note" | "task";
  agentId?: string;
  model?: string;
}

export interface AiGrammarIssue {
  original: string;
  suggestion: string;
  explanation: string;
}

/** `ai.done` result for grammar: the fully corrected text plus what changed. */
export interface AiGrammarResult {
  corrected: string;
  issues: AiGrammarIssue[];
}

/** `ai.done` result for metadata: the type and props, already validated against its schema. */
export interface AiMetadataResult {
  objectTypeId: string;
  props: ObjectProps;
}

export interface AiDeltaEvent {
  runId: string;
  text: string;
}

export interface AiDoneEvent {
  runId: string;
  task: AiTask;
  text: string;
  result?: AiGrammarResult | AiMetadataResult | null;
  agent: string;
  model: string;
}

export interface AiErrorEvent {
  runId: string;
  error: string;
}

/** Typed wrappers over the ai.* core methods. */
export function aiApi(core: CoreBridge) {
  return {
    status: () => core.invoke<AiStatus>("ai.status"),
    /** Start a run; returns once it's under way. Output arrives through the events below. */
    run: (input: AiRunInput) => core.invoke<{ ok: boolean; runId: string; agent: string; model: string }>("ai.run", input),
    cancel: (runId: string) => core.invoke<{ ok: boolean; cancelled: boolean }>("ai.cancel", { runId }),
    onDelta: (cb: (e: AiDeltaEvent) => void) => core.on("ai.delta", (p) => cb(p as AiDeltaEvent)),
    onDone: (cb: (e: AiDoneEvent) => void) => core.on("ai.done", (p) => cb(p as AiDoneEvent)),
    onError: (cb: (e: AiErrorEvent) => void) => core.on("ai.error", (p) => cb(p as AiErrorEvent)),
  };
}

export type AiApi = ReturnType<typeof aiApi>;
