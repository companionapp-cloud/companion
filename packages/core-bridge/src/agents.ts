import type { CoreBridge } from "./types";

/** How Companion talks to an agent (mirrors core/domain.Runtime, PLAN-agents.md §0). */
export type AgentRuntime =
  | "anthropic-api"
  | "openai-api"
  | "openai-compatible"
  | "claude-cli"
  | "codex-cli"
  | "ollama"
  | "lmstudio";

export const CLI_RUNTIMES: readonly AgentRuntime[] = ["claude-cli", "codex-cli"];
export const CLOUD_RUNTIMES: readonly AgentRuntime[] = ["anthropic-api", "openai-api"];

export function isCliRuntime(r: AgentRuntime): boolean {
  return CLI_RUNTIMES.includes(r);
}
export function isCloudRuntime(r: AgentRuntime): boolean {
  return CLOUD_RUNTIMES.includes(r);
}

/** Human label for a runtime (matches core/domain.Runtime.Label). */
export function runtimeLabel(r: AgentRuntime): string {
  switch (r) {
    case "anthropic-api":
      return "Anthropic API";
    case "openai-api":
      return "OpenAI API";
    case "openai-compatible":
      return "OpenAI-compatible server";
    case "claude-cli":
      return "Claude Code";
    case "codex-cli":
      return "Codex CLI";
    case "ollama":
      return "Ollama";
    case "lmstudio":
      return "LM Studio";
    default:
      return r;
  }
}

/** An installed agent (mirrors core/domain.Agent plus the bridge's view fields). Cloud agents
 *  run anywhere with their key; local agents are hosted by one desktop (`hostDeviceId`) and are
 *  reached from other devices through the relay. The model is picked per chat. The API key
 *  never crosses this boundary in the clear on read. */
export interface Agent {
  id: string;
  name: string;
  runtime: AgentRuntime;
  baseUrl: string;
  hostDeviceId?: string | null;
  hostName?: string | null;
  binaryPath?: string | null;
  binaryVersion?: string | null;
  /** Companion's write tools (create/update notes and tasks). On by default. */
  allowWrite: boolean;
  /** CLI agents only: edit files and run shell commands on the host. Off by default. */
  allowSystem: boolean;
  apiKeyEnc?: string | null;
  apiKeyRef?: string | null;
  settingsJson: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
  /** True when this device is the agent's host (or it is a cloud agent). */
  hostedHere: boolean;
  /** True when the agent can be chatted with right now from this device. */
  online: boolean;
  /** True when this device can supply the agent's API key (synced on the row, or in this
   *  device's keychain). */
  hasKey: boolean;
}

/** What discovery found on this machine (mirrors core/agents.Discovered). */
export interface DiscoveredAgent {
  runtime: AgentRuntime;
  name: string;
  /** Binary path for CLIs, base URL for local servers. */
  path: string;
  version?: string;
  status: "ready" | "needs_login" | "not_running" | "unsupported_version";
  detail?: string;
  models?: string[];
  installedAgentId?: string | null;
}

export interface InstallAgentInput {
  runtime: AgentRuntime;
  name?: string;
  /** HTTP runtimes only; defaults to the runtime's standard endpoint. */
  baseUrl?: string;
  /** Cloud runtimes: the key. Encrypted into the synced row on an E2EE account, else kept in
   *  the device keychain. Never persisted in the clear on the wire. */
  apiKey?: string;
  binaryPath?: string;
  binaryVersion?: string;
  /** Defaults to true. */
  allowWrite?: boolean;
  /** Defaults to false. */
  allowSystem?: boolean;
  settingsJson?: string;
  isDefault?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  allowWrite?: boolean;
  allowSystem?: boolean;
  settingsJson?: string;
}

/** Typed wrappers over the agents.* core methods (PLAN-agents.md §2.1). */
export function agentsApi(core: CoreBridge) {
  return {
    list: () => core.invoke<Agent[]>("agents.list"),
    install: (input: InstallAgentInput) => core.invoke<Agent>("agents.install", input),
    update: (id: string, fields: UpdateAgentInput) => core.invoke<Agent>("agents.update", { id, ...fields }),
    remove: (id: string) => core.invoke<{ ok: boolean }>("agents.remove", { id }),
    setDefault: (id: string) => core.invoke<{ ok: boolean }>("agents.setDefault", { id }),
    /** Scan this machine for supported local tools. Empty on shells that cannot exec. */
    discover: () => core.invoke<DiscoveredAgent[]>("agents.discover"),
    /** The models an agent currently offers: live for HTTP runtimes, curated for CLIs, via the
     *  relay for agents hosted elsewhere (empty when the host is offline). */
    models: (agentId: string) => core.invoke<string[]>("agents.models", { agentId }),
    /** Fires when the agent list or any agent's online state changes — re-fetch. */
    onChanged: (cb: () => void) => core.on("agents.changed", () => cb()),
  };
}

export type AgentsApi = ReturnType<typeof agentsApi>;
