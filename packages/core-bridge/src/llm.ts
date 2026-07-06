import type { CoreBridge } from "./types";

/** Where a provider config lives: a local model on this device, or a synced cloud account. */
export type LLMScope = "device" | "account";

/** Provider wire protocol. "openai-compatible" also covers Ollama / LM Studio. */
export type LLMProvider = "openai-compatible" | "anthropic";

/** A configured model the user can chat with (mirrors core/domain.LLMConfig). The API key
 *  never crosses this boundary — only its keychain handle (apiKeyRef). */
export interface LLMConfig {
  id: string;
  scope: LLMScope;
  name: string;
  baseUrl: string;
  provider: LLMProvider;
  model: string;
  apiKeyRef?: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

export interface CreateLLMConfigInput {
  scope: LLMScope;
  name: string;
  baseUrl: string;
  provider: LLMProvider;
  model: string;
  isDefault?: boolean;
  /** Cloud key; written to the OS keychain by the core, never persisted in SQLite. */
  apiKey?: string;
}

export interface UpdateLLMConfigInput {
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** The model's request to run a tool (mirrors core/llm.ToolCall). `args` is the parsed
 *  argument object the model supplied. */
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

/** Typed wrappers over the llm.* core methods (PLAN §6.8). Config CRUD manages the user's
 *  providers; chat runs the on-device agentic loop, streaming tokens and tool actions as
 *  events while returning the final transcript. */
export function llmApi(core: CoreBridge) {
  return {
    configs: {
      list: () => core.invoke<LLMConfig[]>("llm.configs.list"),
      create: (input: CreateLLMConfigInput) => core.invoke<LLMConfig>("llm.configs.create", input),
      update: (id: string, fields: UpdateLLMConfigInput) => core.invoke<LLMConfig>("llm.configs.update", { id, ...fields }),
      remove: (id: string) => core.invoke<{ ok: boolean }>("llm.configs.delete", { id }),
      setDefault: (id: string) => core.invoke<{ ok: boolean }>("llm.configs.setDefault", { id }),
    },
    onToken: (cb: (e: LLMTokenEvent) => void) => core.on("llm.token", (p) => cb(p as LLMTokenEvent)),
    onTool: (cb: (e: LLMToolEvent) => void) => core.on("llm.tool", (p) => cb(p as LLMToolEvent)),
    onError: (cb: (e: LLMErrorEvent) => void) => core.on("llm.error", (p) => cb(p as LLMErrorEvent)),
    /** Fires when the provider list changes (add/edit/remove/default) — re-fetch configs. */
    onConfigsChanged: (cb: () => void) => core.on("llm.configs.changed", () => cb()),
  };
}

export type LlmApi = ReturnType<typeof llmApi>;
