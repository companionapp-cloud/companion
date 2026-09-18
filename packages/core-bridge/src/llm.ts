import type { CoreBridge } from "./types";

// The streaming vocabulary of a chat turn (PLAN §6.8). Agent management moved to agents.ts
// (PLAN-agents.md); this module keeps the transcript shapes and the llm.* events every run
// emits, whether it comes from the built-in engine, a CLI agent, or a remote host.

/** The model's request to run a tool (mirrors core/llm.ToolCall). `args` is the parsed
 *  argument object the model supplied — or, for a CLI agent's tool, the tool's input as a
 *  JSON string. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** The outcome of a tool run fed back to the model (mirrors core/llm.ToolResult). */
export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

/** One turn in the chat transcript (mirrors core/llm.Message). */
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

/** Payload of an `llm.token` event: a chunk of streamed assistant text for a chat. */
export interface LLMTokenEvent {
  chatId: string;
  text: string;
}

/** Payload of an `llm.tool` event: one executed tool call and its result, for a chat. */
export interface LLMToolEvent {
  chatId: string;
  call: ToolCall;
  result: ToolResult;
}

/** Payload of an `llm.error` event. */
export interface LLMErrorEvent {
  chatId: string;
  error: string;
}

/** Event subscriptions for a chat turn's stream. */
export function llmApi(core: CoreBridge) {
  return {
    onToken: (cb: (e: LLMTokenEvent) => void) => core.on("llm.token", (p) => cb(p as LLMTokenEvent)),
    onTool: (cb: (e: LLMToolEvent) => void) => core.on("llm.tool", (p) => cb(p as LLMToolEvent)),
    onError: (cb: (e: LLMErrorEvent) => void) => core.on("llm.error", (p) => cb(p as LLMErrorEvent)),
  };
}

export type LlmApi = ReturnType<typeof llmApi>;
