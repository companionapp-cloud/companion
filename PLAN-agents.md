# Agents — Implementation Plan

Redesign of how AI is added to and used in Companion. Today a "provider" is an endpoint
URL plus an optional API key, configured per device. This plan replaces that with
**agents**: things you *install*. Cloud agents (Anthropic, OpenAI) take an API key.
Local agents (Claude Code, Codex CLI, Ollama, LM Studio) are **discovered** by the desktop
app on the machine they live on, never typed in as a URL, and are **hosted** by that
desktop. Mobile and web chat with a hosted agent by sending the turn through the sync
server to the desktop, which runs it and streams the answer back.

This plan follows `PLAN.md`: logic in the Go core, React as presentation, one
JSON-over-`invoke` API, row-level sync with E2EE, and platform capabilities injected by
the shell rather than detected.

---

## 0. Decisions up front

| Decision | Choice | Why |
|---|---|---|
| Vocabulary | **Agent** replaces "provider". An agent has a `runtime` (how to talk to it) and, if local, a `host_device_id` (which desktop runs it). | "Provider" today conflates wire dialect, endpoint and credentials. Users think "I have Claude on my Mac", not "I have an OpenAI-compatible base URL". |
| Data model | **Evolve `llm_configs` in place** (rename to `agents` in the domain/bridge; keep the table name, add columns) and **make it a synced entity**. | The table already has `version`/`dirty` and the sync seam is generic. Renaming the SQLite table buys nothing. Sync is what lets a phone see "Claude Code on Chris's MacBook". |
| Runtimes | `anthropic-api`, `openai-api` (cloud); `claude-cli`, `codex-cli`, `ollama`, `lmstudio` (local). `openai-compatible` stays as an **advanced/manual** runtime for arbitrary URLs. | Discovery needs to know *what* it found, not just a port. Manual URL entry remains for LAN servers and self-hosters, but leaves the primary flow. |
| Discovery | Desktop-only Go service in `apps/desktop`, run **on demand** (when the Add Agent screen opens, and on "Rescan"). Not a background poller. | Nothing in the desktop polls today; discovery is cheap (a few `LookPath`s and two local HTTP probes). Matches the `/shortcuts` shell-route pattern. |
| Install | Discovery results are ephemeral. "Install" creates an `agents` row with `host_device_id = this device`. | Keeps discovery stateless. The row is the only durable artifact and it syncs. |
| Execution of CLI agents | `os/exec` from the **desktop Go process**, one process per turn, JSONL streaming on stdout, session resumed via the CLI's own session id stored on the chat. | Both CLIs are built for this (`claude -p --output-format stream-json`, `codex exec --json`). Their agentic loop, tools and auth are theirs; we do not reimplement them. |
| Permissions | Two switches per agent. **Write tools** (`allow_write`, on by default): Companion's create/update note and task tools, gated in the MCP grant for CLI agents and in the built-in engine's registry for HTTP agents. **System access** (`allow_system`, off by default, CLI only): file edits and shell commands (`claude --allowedTools …Bash,Edit… --permission-mode acceptEdits` / `codex --sandbox workspace-write`); off means `--disallowedTools Bash,Edit,…` / `--sandbox read-only`. Not Claude's plan mode: that blocks every MCP tool. cwd is a per-agent scratch dir under the Companion data dir. | A phone driving a CLI with write access to the desktop's filesystem is a real footgun. Start locked down. |
| Companion data access for CLI agents | **Phase 3**: expose the existing `core/llm` store tools as an **MCP stdio server** (`companion mcp`) passed via `--mcp-config`. Until then CLI agents answer without Companion context. | The 17 tools already exist in Go. MCP is how both CLIs consume external tools; it is far less work than teaching the CLIs our tool JSON. |
| Device identity | Add the `devices` table from `PLAN.md` §4.2, `POST /v1/devices` register/heartbeat, persist the device id, send it on every sync and relay request. | There is no server-side device concept today; hosting requires one. Also fixes the in-memory `deviceID` re-mint bug in `core/bridge/sync.go`. |
| Remote transport | A **relay** channel in `packages/syncserver`, separate from entity sync: desktop holds an SSE inbox, callers POST requests and read an SSE response stream. Payloads E2E-encrypted with the master key under a relay AAD. | Entity sync is durable but slow and not addressable; using `chat_messages` as a queue would give no token streaming, no presence, and wake every device per token. The relay shares auth, the subscription guard, and `core/crypto`. |
| Persistence of remote turns | The **host desktop** persists messages into its own `chats`/`chat_messages` (exactly what `runChat` does today) and they reach the caller via normal sync. The relay stream is display-only. | One code path writes chat history. The caller renders live tokens from the relay and swaps to canonical rows on `chat.changed`, the same way it does locally today. |
| API keys for cloud agents | Store as an **encrypted field on the synced row** (`api_key_enc`, ChaCha20-Poly1305 via `core/crypto/rows.go`) when the user has E2EE set up; fall back to the local secret store when signed out. | E2EE now exists, so `PLAN.md`'s "secrets endpoint" is unnecessary. One key, entered once, on every device. |
| Offline host | Caller gets an immediate `host_offline` error with the host's `last_seen_at`. No queuing in v1. | Queued turns that run hours later surprise people. Can add "run when my Mac is back" later on top of the same relay. |

---

## 1. Data model

### 1.1 Client SQLite — `core/store/migrations/0018_agents.sql`

```sql
-- llm_configs becomes the agents table. Keep the name; the domain type is Agent.
ALTER TABLE llm_configs ADD COLUMN runtime        TEXT NOT NULL DEFAULT 'openai-compatible';
ALTER TABLE llm_configs ADD COLUMN host_device_id TEXT;            -- NULL for cloud/manual
ALTER TABLE llm_configs ADD COLUMN host_name      TEXT;            -- denormalised for display ("Chris's MacBook")
ALTER TABLE llm_configs ADD COLUMN binary_path    TEXT;            -- CLI runtimes: resolved at install, re-resolved on run
ALTER TABLE llm_configs ADD COLUMN binary_version TEXT;
ALTER TABLE llm_configs ADD COLUMN allow_write    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_configs ADD COLUMN api_key_enc    TEXT;            -- encrypted (1.3); replaces api_key_ref when synced
ALTER TABLE llm_configs ADD COLUMN settings_json  TEXT NOT NULL DEFAULT '{}';  -- runtime-specific, encrypted

-- Backfill runtime from the old provider column.
UPDATE llm_configs SET runtime = 'anthropic-api' WHERE provider = 'anthropic';
UPDATE llm_configs SET runtime = 'openai-api'
  WHERE provider = 'openai-compatible' AND base_url LIKE 'https://api.openai.com%';
UPDATE llm_configs SET runtime = 'ollama'
  WHERE provider = 'openai-compatible' AND base_url LIKE 'http://localhost:11434%';
-- Existing device-scoped rows are claimed by this device on first run (bridge does this,
-- since the device id is not known to SQL).

-- Chats remember the CLI session so multi-turn works across processes.
ALTER TABLE chats ADD COLUMN agent_session_id TEXT;

-- Device identity persists across restarts.
ALTER TABLE sync_state ADD COLUMN device_name TEXT;
ALTER TABLE sync_state ADD COLUMN device_platform TEXT;
```

`scope` and `provider` stay for one release for backward compat and are dropped in a
follow-up migration once every client has migrated. `scope` is now derived:
`host_device_id != NULL` ⇒ local.

### 1.2 Domain — `core/domain/agent.go`

```go
type Runtime string
const (
    RuntimeAnthropicAPI Runtime = "anthropic-api"
    RuntimeOpenAIAPI    Runtime = "openai-api"
    RuntimeOpenAICompat Runtime = "openai-compatible" // manual URL, advanced
    RuntimeClaudeCLI    Runtime = "claude-cli"
    RuntimeCodexCLI     Runtime = "codex-cli"
    RuntimeOllama       Runtime = "ollama"
    RuntimeLMStudio     Runtime = "lmstudio"
)

type Agent struct {
    ID, Name        string
    Runtime         Runtime
    BaseURL         string  // http runtimes only
    HostDeviceID    *string // set ⇒ local, hosted by that device
    HostName        *string
    BinaryPath      *string
    BinaryVersion   *string
    AllowWrite      bool
    APIKeyEnc       *string // encrypted; nil for local
    APIKeyRef       *string // legacy local secret store
    SettingsJSON    string
    IsDefault       bool
    CreatedAt, UpdatedAt string; DeletedAt *string
    Version int64; Dirty bool
}

func (a Agent) IsLocal() bool        { return a.HostDeviceID != nil }
func (a Agent) IsHostedBy(dev string) bool
func (r Runtime) IsCLI() bool        // claude-cli, codex-cli
func (r Runtime) IsHTTP() bool       // everything else
```

`Agent` implements `SyncEntity`. `LLMConfig` is deleted; the bridge methods are renamed
(§2) with the old names kept as aliases for one release.

### 1.3 Encryption — `core/crypto/rows.go`

Add `EntityAgent` with encrypted fields `name`, `baseUrl`, `apiKeyEnc`, `settingsJson`,
`binaryPath`. Plaintext: ids, `runtime`, `hostDeviceId`, `isDefault`, timestamps.
`hostDeviceId` must be plaintext so the server can route relay requests without
decrypting anything.

New AAD label `aadRelay = "relay/v1"` and two helpers on `Cipher`:
`SealBlob(aad string, b []byte)` / `OpenBlob(...)`, used by the relay for whole-payload
encryption (the relay does not go through the per-field row path).

### 1.4 Server — `packages/syncserver/db.go`

```sql
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,           -- client-minted UUIDv7 from sync_state.device_id
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL DEFAULT '',   -- E2E encrypted envelope
  platform     TEXT NOT NULL,              -- macos | windows | linux | ios | android | web
  can_host     INTEGER NOT NULL DEFAULT 0, -- desktop shells only
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE agents (                      -- synced entity; same shape as every other
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  row_json TEXT NOT NULL, version BIGINT NOT NULL, server_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ
);

CREATE TABLE relay_requests (              -- short-lived; rows expire after 10 minutes
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  from_device_id TEXT NOT NULL,
  to_device_id   TEXT NOT NULL,
  method         TEXT NOT NULL,
  payload        BYTEA NOT NULL,           -- sealed by core/crypto (server cannot read)
  status         TEXT NOT NULL,            -- pending | delivered | done | failed | expired
  created_at     TIMESTAMPTZ NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL
);
```

Register `EntityAgent` in `packages/syncserver/sync.go` and `core/sync/protocol`.

---

## 2. Core API (bridge methods)

### 2.1 Agents (replaces `llm.configs.*`)

| Method | Payload → Result | Notes |
|---|---|---|
| `agents.list` | → `Agent[]` (with `online: bool` for local agents, from device presence) | Replaces `llm.configs.list` |
| `agents.install` | `{runtime, name, baseUrl?, apiKey?, binaryPath?, binaryVersion?, hostDeviceId?}` → `Agent` | Cloud: encrypts the key. Local: `hostDeviceId` is filled by the core from `sync_state` |
| `agents.update` | `{id, name?, apiKey?, allowWrite?, settings?}` → `Agent` | |
| `agents.remove` | `{id}` | |
| `agents.setDefault` | `{id}` | |
| `agents.models` | `{agentId}` → `string[]` | Local remote-hosted agents: routed through the relay to the host |
| `agents.discover` | → `Discovered[]` | **Desktop only**; `js`/mobile builds return `[]`. See §3 |

Events: `agents.changed` (replaces `llm.configs.changed`), `devices.presence`
`{deviceId, online, lastSeenAt}`.

### 2.2 Devices

| Method | Payload → Result |
|---|---|
| `devices.this` | → `{id, name, platform, canHost}` |
| `devices.rename` | `{name}` |
| `devices.list` | → `Device[]` with `online` |

The device registers with the server on `sync.configure` and heartbeats on every
`sync.run` (piggybacked as `X-Companion-Device` header on push/pull, so no extra round
trip).

### 2.3 Chats — unchanged surface, new routing

`chats.send {chatId, text, agentId?, model?}` stays. Inside `chatsSend`:

```
agent := resolveAgent(agentId)
switch {
case !agent.IsLocal():                 runLocally(engineFor(agent))            // today's path
case agent.IsHostedBy(thisDevice):     runLocally(runtimeFor(agent))           // §4
default:                               runRemotely(agent.HostDeviceID, …)      // §5
}
```

`engineFor` is today's `buildEngine` for HTTP runtimes. `runtimeFor` returns a
`llm.Provider`-shaped adapter for CLI runtimes (§4). Both stream into the same
`llm.token` / `llm.tool` / `llm.error` events, so `ChatView` does not change.

---

## 3. Discovery service (desktop)

`apps/desktop/agents_discovery.go`, exposed to the core through a new seam
`bridge.AgentDiscoverer` (like `SecretStore`), so the bridge method `agents.discover`
works on every platform and returns `[]` where nothing is injected.

```go
type Discovered struct {
    Runtime   domain.Runtime
    Name      string   // "Claude Code", "Codex CLI", "Ollama", "LM Studio"
    Path      string   // binary path (CLI) or base URL (HTTP)
    Version   string
    Status    string   // ready | needs_login | not_running | unsupported_version
    Models    []string // HTTP runtimes: what the server reports right now
    Installed *string  // agent id if an agents row already points at this
}
```

Probes, all with a 1.5 s budget in parallel:

| Runtime | How |
|---|---|
| `claude-cli` | `exec.LookPath("claude")` plus known dirs a GUI app's PATH misses: `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.nvm/versions/node/*/bin`. Then `claude --version`. Login state: run `claude -p "ping" --output-format json --max-turns 1` only on explicit "Test" (it costs a call); otherwise report `ready` if the binary runs. |
| `codex-cli` | Same dir list, `codex --version`. |
| `ollama` | `GET http://127.0.0.1:11434/api/version`, then `/api/tags` for models. If not reachable but `ollama` binary or `/Applications/Ollama.app` exists, report `not_running` with a "Start Ollama" hint. |
| `lmstudio` | `GET http://127.0.0.1:1234/v1/models`. |

Results are never persisted. The Add Agent screen shows them as cards with **Install**.
Install calls `agents.install` with the discovered runtime/path/version and
`hostDeviceId = this device`. Windows/Linux: same code, different dir lists via
`//go:build` files.

---

## 4. Running a local agent on the host

`core/agentrt/` (build tag `!js`): one adapter per CLI runtime implementing a small
interface the bridge already understands:

```go
type Runner interface {
    // Start one turn. Returns the runtime's session id (for resume) once known.
    Run(ctx, RunRequest, onDelta func(string), onTool func(name, input string)) (RunResult, error)
    ListModels(ctx) ([]string, error)
}
type RunRequest struct { Prompt, Model, SessionID string; AllowWrite bool; Cwd string; MCPConfig string }
type RunResult  struct { SessionID, Text string; Usage map[string]any }
```

### 4.1 Claude Code

```
claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
       [--resume <sessionId>] [--model <m>] [--permission-mode plan | acceptEdits]
       [--mcp-config <companion-mcp.json>]
```

Parse JSONL: `stream_event` → `content_block_delta.text_delta` feeds `onDelta`;
`assistant` messages with `tool_use` blocks feed `onTool`; the final `result` event
carries `session_id`, cost and the full text. Store `session_id` on
`chats.agent_session_id`. `--permission-mode plan` when `allow_write = 0`.

### 4.2 Codex CLI

```
codex exec --json [-m <model>] [--sandbox read-only | workspace-write] -C <cwd> <prompt>
codex exec resume <sessionId> --json <prompt>
```

JSONL events: `item.completed` with `agent_message` → text; `command_execution` /
`file_change` → `onTool`. Flag shapes must be verified against the installed version
on first implementation; keep the parser tolerant of unknown event types.

### 4.3 Ollama / LM Studio

Today's `OpenAIProvider` with the discovered base URL, run through today's `Engine`
with the store tools. No new code beyond the runtime tag.

### 4.4 Process hygiene

- `ctx` cancellation kills the process group; `chats.cancel {chatId}` is a new method.
- Concurrency: one turn per chat, N turns per host (default 2), queued beyond that.
- Environment: inherit the user's shell PATH by running the discovered absolute path,
  set `HOME`, unset Companion-specific vars. Never pass secrets by argv.
- Working directory per agent: `<UserConfigDir>/Companion/agents/<agentId>/` so a
  write-enabled agent has somewhere harmless to write.

### 4.5 MCP bridge (phase 3)

`companion-desktop mcp` subcommand: stdio MCP server that wraps `llm.NewStoreRegistry`
and exposes the same 17 tools (search_notes, list_tasks, create_note, …) with the same
JSON schemas. The desktop writes `<agentDir>/mcp.json` pointing at its own binary and
passes it via `--mcp-config` / Codex's MCP config. Write tools are only exposed when
`allow_write = 1`. This is how Claude Code and Codex get "ask my data" parity with the
built-in engine.

---

## 5. Relay: chatting with a hosted agent from another device

### 5.1 Server — `packages/syncserver/relay.go`

| Route | Who | What |
|---|---|---|
| `POST /v1/devices` | every client | Upsert `{id, name(enc), platform, canHost}`; touches `last_seen_at`. |
| `GET /v1/devices` | every client | List with `online` = has an open inbox or heartbeat in last 90 s. |
| `GET /v1/relay/inbox` | **host desktop** | Long-lived SSE. Frames: `request {id, fromDeviceId, method, payload}`, `cancel {id}`, `: ping` every 25 s. Connecting marks the device online. |
| `POST /v1/relay/request` | caller | `{toDeviceId, method, payload}` → `{requestId}`. `409 host_offline` if no inbox is open. Inserts a `relay_requests` row, publishes to the host's channel. |
| `GET /v1/relay/response/{id}` | caller | SSE of response frames until `done`/`error`. |
| `POST /v1/relay/response/{id}` | host | Body is one or more frames `{type: delta|tool|done|error, payload}`; server fans them to the caller's stream. |
| `POST /v1/relay/cancel/{id}` | caller | Forwards `cancel` to the host inbox. |

Both directions check `devices.user_id == UserID(r)`. The hub becomes
`map[deviceID] → chan Frame` alongside the existing user-keyed `Hub`. Requests with no
response frame for 60 s are marked `expired` and the caller gets `error host_timeout`.
Single-instance for now, like the existing hub; `LISTEN/NOTIFY` when the server scales.

All `payload` bytes are `Cipher.SealBlob(aadRelay, …)` on the client. The server sees
method names and device ids only.

### 5.2 Client — `packages/core-bridge/src/relay.ts` + `core/bridge/relay.go`

Caller side (`runRemotely`):

1. `sync.run` first so the `chats` row and the user's `chat_messages` row exist on the
   server (the host needs them).
2. `POST /v1/relay/request {toDeviceId, method: "chats.send", payload: seal({chatId, text, agentId, model})}`.
3. Open the response stream; map `delta` → `llm.token`, `tool` → `llm.tool`,
   `error` → `llm.error`, `done` → `chat.working false`. The UI is untouched.
4. On `done`, trigger `sync.run`; the host's persisted messages arrive and
   `chat.changed` swaps the live buffer for canonical rows, as it does locally.

Host side (`apps/desktop` keeps the inbox open whenever signed in, using the same
fetch+ReadableStream SSE parser as `notifier.ts`):

1. On `request`: `open(payload)`, `sync.run` (pull the caller's new rows), then call
   `Core.Invoke(method, payload)` — the bridge is already a string+JSON RPC, so a remote
   command is literally a remote `Invoke`.
2. Subscribe to `llm.token` / `llm.tool` / `llm.error` / `chat.working` filtered by
   `chatId` and forward each as a sealed response frame. Batch deltas at ~50 ms.
3. On `chat.working false`: `sync.run` (push the new messages), send `done`.

Allow-listed relay methods on the host: `chats.send`, `chats.cancel`, `agents.models`.
Anything else is rejected before `Invoke`.

### 5.3 Presence in the UI

`agents.list` decorates local agents with `online` from `GET /v1/devices`. The agent
picker shows "Claude Code · Chris's MacBook · offline" greyed out; sending is blocked
with the reason. Desktop shows a menubar hint when it is hosting a turn for another
device.

---

## 6. UI

### 6.1 Settings → AI (rewrite `LlmSettings.tsx` → `AgentsSettings.tsx`)

```
Installed agents
  ● Claude Code            Chris's MacBook · online · default          ⋯
  ● Ollama (llama3.1)      Chris's MacBook · online                    ⋯
  ○ Anthropic API          cloud                                       ⋯

[ + Add agent ]
```

**Add agent** sheet:

- **On this computer** (desktop only; section hidden when `agents.discover` returns
  nothing or the shell is not desktop): cards from discovery with version, status and
  **Install** / **Installed ✓**. "Rescan" button. Empty state links to install docs for
  each tool.
- **Cloud**: Anthropic, OpenAI — name + API key. Same as today minus the URL.
- **Advanced**: "Custom OpenAI-compatible server" — the only place a URL is typed.

Per-agent detail: rename, set default, **Allow this agent to write files** toggle (CLI
runtimes, with a warning), **Test** (runs a one-token turn), remove. Local agents show
"Hosted by <device>"; from a non-host device the actions are limited to rename /
default / remove.

### 6.2 Chat

`SelectorBar` shows `model · agent` where agent labels include the host for local ones.
Offline hosts are selectable but the composer shows "Chris's MacBook is offline" instead
of Send. `EmptyState` copy: "Install an agent — Companion found Claude Code on this
Mac" when discovery has results, otherwise today's copy.

### 6.3 Settings → Sync → This device

Device name (defaults to hostname / iOS device name), platform, "Can host agents"
badge on desktop, list of other devices with last seen.

---

## 7. Phases

### Phase 1 — Agents model and discovery, desktop only (no relay)
- Migration 0018, `domain.Agent`, repo, bridge methods with `llm.configs.*` aliases.
- `AgentDiscoverer` seam + `apps/desktop/agents_discovery.go` + tests with fake dirs
  and an `httptest` Ollama.
- `core/agentrt` Claude Code and Codex runners; `chats.cancel`; session id on chats.
- `AgentsSettings.tsx` with the three-section Add sheet. Manual URL moves to Advanced.
- Existing `device`-scope rows claimed by this device on first launch.
**Outcome:** on desktop, Add agent → sees Claude Code / Codex / Ollama → Install → chat.

### Phase 2 — Sync and devices
- `EntityAgent` synced and encrypted; `api_key_enc` for cloud agents (keychain fallback).
- `devices` table, `POST/GET /v1/devices`, persisted device id, presence.
- Mobile/web see all agents; hosted ones show host and online state; sending to a hosted
  agent from another device is blocked with "coming soon" copy.

### Phase 3 — Relay
- `relay.go`, device-keyed hub, sealed payloads, expiry.
- Host inbox in the desktop shell; `runRemotely` in the bridge; `relay.ts` notifier.
- End-to-end: phone → sync server → Mac runs Claude Code → tokens on the phone.

### Phase 4 — MCP bridge
- `companion-desktop mcp` stdio server over `llm.NewStoreRegistry`; wired into CLI runs.
- Write tools gated on `allow_write`.

### Phase 5 — Hardening and stretch
- Drop `scope`/`provider` columns; remove bridge aliases.
- `LISTEN/NOTIFY` for multi-instance relay; queued turns for offline hosts.
- Windows/Linux discovery dir lists; LM Studio; Gemini CLI as another `Runner`.

---

## 8. Testing

- `core/agentrt`: table tests feeding recorded JSONL transcripts from both CLIs through
  the parsers; a fake `claude` shell script in `testdata` for process lifecycle and
  cancellation.
- `apps/desktop/agents_discovery_test.go`: temp dirs with fake binaries, `httptest`
  Ollama and LM Studio, timeout behaviour.
- `packages/syncserver/relay_test.go`: two authed clients, host inbox + caller stream,
  cross-user rejection, `host_offline`, expiry, cancel.
- `core/bridge`: `chats.send` routing table (cloud / hosted-here / hosted-elsewhere).
- Sync round-trip test for `EntityAgent` including encrypted `apiKeyEnc`.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| CLI flag/JSON drift between versions | Record `binary_version` at install; parsers ignore unknown events; `Test` button surfaces breakage early; pin a minimum version per runtime. |
| GUI app PATH misses user binaries | Explicit dir list per OS plus `LookPath`; store the absolute path; re-resolve on run and fall back to rescan. |
| Remote device drives a write-capable CLI | Read-only by default, per-agent opt-in with warning, per-agent scratch cwd, MCP write tools gated on the same flag. |
| Relay payloads readable by server | Sealed with the master key under `relay/v1` AAD; server routes on device ids only. Any signed-in device can decrypt (same trust model as all synced data). |
| Lossy single-instance hub | `relay_requests` row + 60 s response timeout gives the caller a definite error; `LISTEN/NOTIFY` later. |
| Mobile SSE is foreground-only | Mobile is caller-only; the desktop is the only host. Backgrounding mid-turn is fine: the host finishes and persists, the phone catches up on sync. |
| Race: request arrives before the caller's rows synced | Caller awaits `sync.run` before posting; host runs `sync.run` on receipt before `Invoke`. |
| Claude Code login/quota state | Discovery reports `ready`; the first turn's `error` frame carries the CLI's message verbatim ("Please run claude login"). |

---

## 10. Open questions

1. Should cloud API keys sync as encrypted row fields (this plan) or stay per-device?
   Syncing is more convenient; per-device is stricter if one device is untrusted.
2. Default host concurrency and whether a host can be paused ("Do not host while I'm
   presenting").
3. Whether the desktop should keep the relay inbox open while the window is hidden
   (menubar mode). This plan says yes, since that is the whole point of hosting.
4. Codex CLI exact `exec` flags for JSON streaming and resume vary by version; confirm
   against the version we target before Phase 1 ends.

---

## 11. Status (2026-09-18)

Phases 1–4 are implemented on `feat/dense-redesign`; Phase 5 (hardening) is open.

| Area | State | Where |
|---|---|---|
| Agents model, migration 0018, synced entity, encrypted fields | done | `core/domain/agent.go`, `core/store/agents.go`, `core/crypto/rows.go`, `core/sync/protocol` |
| Device identity (stable id, name, platform, can-host) | done | `core/store/sync.go`, `core/bridge/devices.go` |
| Discovery (PATH + known dirs + login shell; Ollama/LM Studio probes) | done | `core/agentrt/discover.go` |
| Claude Code / Codex runners (stream-json, session resume, cancel, read-only default) | done | `core/agentrt/claude.go`, `codex.go`, `exec.go` |
| Bridge: `agents.*`, `devices.*`, `chats.cancel`, routing (HTTP / CLI / remote) | done | `core/bridge/agents.go`, `chats.go` |
| Server: `devices`, `agents`, `relay_requests` tables; `/v1/devices`, `/v1/relay/*` | done | `packages/syncserver/devices.go`, `relay.go`, `agents_entity.go` |
| Client relay: registration, presence, host inbox loop, remote turns, sealed payloads | done | `core/bridge/relay.go`, `sync.go` |
| MCP server for CLI agents (loopback Streamable HTTP, per-agent token, write-tool gating) | done | `core/mcp/server.go`, `core/bridge/mcp.go` |
| Split permissions: write tools (default on) vs system access (default off), migration 0019 | done | `core/store/migrations/0019_agent_permissions.sql`, `AgentsSettings.tsx` |
| UI: Settings › AI (installed list, Add: On this computer / Cloud / Advanced), This device, chat selector with host + offline state, Stop | done | `packages/app/src/AgentsSettings.tsx`, `SyncSettings.tsx`, `ChatScreen.tsx` |
| Desktop wiring (discoverer, runners, device info) | done | `apps/desktop/main.go` |
| Tests | done | store, bridge, agentrt (fake CLIs), mcp, syncserver relay unit + two-core end-to-end |

Deviations from the plan above:
- Discovery lives in `core/agentrt` (injected by the desktop through `bridge.SetAgentDiscoverer`) rather than as a desktop-only HTTP route, so the same bridge method works on every shell and returns `[]` where nothing is injected.
- The MCP bridge is an in-process loopback HTTP server started lazily by the desktop core, not a `companion mcp` stdio subcommand, so tool writes emit the normal refresh events and there is never a second SQLite handle.
- Chat rows keep the `configId` field name on the wire (it now holds the agent id) for compatibility with already-synced chats.
- The legacy `llm.configs.*` bridge methods remain as aliases of `agents.*`.
- Claude Code's read-only mode uses explicit `--allowedTools` / `--disallowedTools` lists rather than `--permission-mode plan`, because plan mode denies MCP tools (verified against Claude Code 2.1.x: with plan mode the agent could not search notes; with the allowlist it calls `mcp__companion__search_notes` and answers with a wikilink).

Not yet done (Phase 5): dropping `scope`/`provider` columns, LISTEN/NOTIFY for multi-instance relay, queued turns for offline hosts, Windows/Linux discovery verification on real machines, and verifying the Codex `--json` event shapes against the version users actually install.
