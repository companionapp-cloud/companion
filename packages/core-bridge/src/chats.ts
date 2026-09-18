import type { CoreBridge } from "./types";
import type { ChatMessage } from "./llm";

/** A saved conversation (mirrors core/domain.Chat + its runtime working flag). */
export interface Chat {
  id: string;
  title: string;
  /** The agent this chat runs on (nil = the default agent at run time). Named configId on the
   *  wire for compatibility with rows synced before agents existed. */
  configId?: string | null;
  /** The model chosen for this chat (picked at chat time from the agent's live list). */
  model?: string | null;
  /** A CLI agent's own session id, resumed on the next turn. */
  agentSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
  /** True while a reply is generating in the background (list spinner). */
  working?: boolean;
}

/** A persisted chat message (mirrors core/domain.ChatMessage). */
export interface StoredChatMessage {
  id: string;
  chatId: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ChatDetail {
  chat: Chat;
  messages: StoredChatMessage[];
  working: boolean;
}

/** Payload of a `chat.changed` event: a chat's messages or title changed — reload it. */
export interface ChatChangedEvent {
  chatId: string;
}

/** Payload of a `chat.working` event: a chat's background run started/finished. */
export interface ChatWorkingEvent {
  chatId: string;
  working: boolean;
}

/** Typed wrappers over the chats.* core methods (PLAN §6.8). Chats persist and sync; sending
 *  a message runs the assistant in the background, so replies resolve even off-screen. */
export function chatsApi(core: CoreBridge) {
  return {
    list: () => core.invoke<Chat[]>("chats.list"),
    get: (id: string) => core.invoke<ChatDetail>("chats.get", { id }),
    create: (input?: { title?: string; agentId?: string | null }) => core.invoke<Chat>("chats.create", input ?? {}),
    rename: (id: string, title: string) => core.invoke<{ ok: boolean }>("chats.rename", { id, title }),
    remove: (id: string) => core.invoke<{ ok: boolean }>("chats.delete", { id }),
    /** Append a user message and start the background run. Returns immediately. The agent and
     *  model re-pin the chat when they differ from what it last ran on. `remote` is set when the
     *  turn was handed to the agent's host device through the relay. */
    send: (chatId: string, text: string, agentId?: string | null, model?: string | null) =>
      core.invoke<{ ok: boolean; working: boolean; remote?: boolean }>("chats.send", { chatId, text, agentId, model }),
    /** Abort a chat's in-flight run (kills a CLI child / closes the stream). */
    cancel: (chatId: string) => core.invoke<{ ok: boolean; cancelled: boolean }>("chats.cancel", { chatId }),
    /** The ids of chats currently generating a reply. */
    working: () => core.invoke<string[]>("chats.working"),

    onChanged: (cb: (e: ChatChangedEvent) => void) => core.on("chat.changed", (p) => cb(p as ChatChangedEvent)),
    onWorking: (cb: (e: ChatWorkingEvent) => void) => core.on("chat.working", (p) => cb(p as ChatWorkingEvent)),
  };
}

export type ChatsApi = ReturnType<typeof chatsApi>;
export type { ChatMessage };
