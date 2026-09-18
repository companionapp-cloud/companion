package domain

import (
	"errors"
	"strings"
	"time"
)

// Runtime is how Companion talks to an agent (PLAN-agents.md §0). HTTP runtimes speak a wire
// dialect to an endpoint; CLI runtimes are child processes of the hosting desktop.
type Runtime string

const (
	// Cloud APIs: the user supplies an API key.
	RuntimeAnthropicAPI Runtime = "anthropic-api"
	RuntimeOpenAIAPI    Runtime = "openai-api"
	// Any Chat Completions server the user points at by URL (LAN Ollama, OpenRouter, vLLM…).
	// Kept as the "Advanced" path; discovered local servers use the specific runtimes below.
	RuntimeOpenAICompat Runtime = "openai-compatible"
	// Local, discovered on the hosting desktop.
	RuntimeClaudeCLI Runtime = "claude-cli"
	RuntimeCodexCLI  Runtime = "codex-cli"
	RuntimeOllama    Runtime = "ollama"
	RuntimeLMStudio  Runtime = "lmstudio"
)

// Legacy column values kept for the transition (PLAN §6.8). scope is now derived from
// HostDeviceID; provider is derived from the runtime's wire dialect.
const (
	ScopeDevice  = "device"
	ScopeAccount = "account"

	ProviderOpenAI    = "openai-compatible"
	ProviderAnthropic = "anthropic"
)

// AllRuntimes lists every runtime the core understands, for validation and pickers.
var AllRuntimes = []Runtime{
	RuntimeAnthropicAPI, RuntimeOpenAIAPI, RuntimeOpenAICompat,
	RuntimeClaudeCLI, RuntimeCodexCLI, RuntimeOllama, RuntimeLMStudio,
}

// IsCLI reports whether the runtime is a child process (needs a host that can exec it).
func (r Runtime) IsCLI() bool { return r == RuntimeClaudeCLI || r == RuntimeCodexCLI }

// IsHTTP reports whether the runtime is reached over HTTP with a base URL.
func (r Runtime) IsHTTP() bool { return r != "" && !r.IsCLI() }

// IsCloud reports whether the runtime is a hosted API reachable from any device with a key.
func (r Runtime) IsCloud() bool { return r == RuntimeAnthropicAPI || r == RuntimeOpenAIAPI }

// NeedsAPIKey reports whether the runtime requires a credential to work.
func (r Runtime) NeedsAPIKey() bool { return r.IsCloud() }

// WireProtocol maps a runtime to the HTTP dialect the llm package speaks for it. CLI runtimes
// have none.
func (r Runtime) WireProtocol() string {
	switch r {
	case RuntimeAnthropicAPI:
		return ProviderAnthropic
	case RuntimeOpenAIAPI, RuntimeOpenAICompat, RuntimeOllama, RuntimeLMStudio:
		return ProviderOpenAI
	default:
		return ""
	}
}

// DefaultBaseURL is the endpoint a runtime uses when the caller supplies none.
func (r Runtime) DefaultBaseURL() string {
	switch r {
	case RuntimeAnthropicAPI:
		return "https://api.anthropic.com"
	case RuntimeOpenAIAPI:
		return "https://api.openai.com/v1"
	case RuntimeOllama:
		return "http://127.0.0.1:11434/v1"
	case RuntimeLMStudio:
		return "http://127.0.0.1:1234/v1"
	default:
		return ""
	}
}

// Label is the human name of a runtime for UI copy.
func (r Runtime) Label() string {
	switch r {
	case RuntimeAnthropicAPI:
		return "Anthropic API"
	case RuntimeOpenAIAPI:
		return "OpenAI API"
	case RuntimeOpenAICompat:
		return "OpenAI-compatible server"
	case RuntimeClaudeCLI:
		return "Claude Code"
	case RuntimeCodexCLI:
		return "Codex CLI"
	case RuntimeOllama:
		return "Ollama"
	case RuntimeLMStudio:
		return "LM Studio"
	default:
		return string(r)
	}
}

// ValidRuntime reports whether r is one the core understands.
func ValidRuntime(r Runtime) bool {
	for _, k := range AllRuntimes {
		if k == r {
			return true
		}
	}
	return false
}

// Agent is one installed AI agent the user can chat with (PLAN-agents.md §1.2). Cloud agents
// carry a key and run anywhere; local agents are hosted by one desktop (HostDeviceID) and are
// driven from other devices through the relay. The model is not part of the agent — it is
// chosen at chat time and remembered per chat. The row syncs (entity "agent") with name,
// base URL, key, settings and binary path encrypted; runtime and host id stay plaintext so
// other devices can route without decrypting.
type Agent struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Runtime Runtime `json:"runtime"`
	// BaseURL is the endpoint for HTTP runtimes; "" for CLI runtimes.
	BaseURL string `json:"baseUrl"`
	// HostDeviceID, when set, is the desktop that runs this agent. Nil means "any device".
	HostDeviceID *string `json:"hostDeviceId,omitempty"`
	// HostName is a display copy of the host's device name ("Chris's MacBook").
	HostName *string `json:"hostName,omitempty"`
	// BinaryPath / BinaryVersion describe a CLI runtime as found at install time.
	BinaryPath    *string `json:"binaryPath,omitempty"`
	BinaryVersion *string `json:"binaryVersion,omitempty"`
	// AllowWrite lets the agent use Companion's write tools (create/update notes and tasks).
	// On by default.
	AllowWrite bool `json:"allowWrite"`
	// AllowSystem lets a CLI agent edit files and run shell commands on its host. Off by default.
	AllowSystem bool `json:"allowSystem"`
	// APIKeyEnc is the cloud API key. On the wire it is an enc$v1$ envelope; locally it is the
	// plaintext key (decrypted on pull). Nil for local agents or when the key lives only in the
	// device secret store (APIKeyRef).
	APIKeyEnc *string `json:"apiKeyEnc,omitempty"`
	// APIKeyRef is the legacy per-device secret-store handle, used when the account is not
	// end-to-end encrypted (so the key must not sync in the row).
	APIKeyRef *string `json:"apiKeyRef,omitempty"`
	// SettingsJSON holds runtime-specific options (model defaults, extra flags) as a JSON object.
	SettingsJSON string     `json:"settingsJson"`
	IsDefault    bool       `json:"isDefault"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	DeletedAt    *time.Time `json:"deletedAt,omitempty"`
	Version      int64      `json:"version"`
	Dirty        bool       `json:"dirty"`
}

// IsLocal reports whether the agent is hosted by a specific device.
func (a *Agent) IsLocal() bool { return a.HostDeviceID != nil && *a.HostDeviceID != "" }

// IsHostedBy reports whether deviceID is this agent's host.
func (a *Agent) IsHostedBy(deviceID string) bool {
	return a.IsLocal() && deviceID != "" && *a.HostDeviceID == deviceID
}

// Scope is the legacy device/account value derived from hosting.
func (a *Agent) Scope() string {
	if a.IsLocal() {
		return ScopeDevice
	}
	return ScopeAccount
}

// HasAPIKey reports whether a credential is available in either storage.
func (a *Agent) HasAPIKey() bool {
	return (a.APIKeyEnc != nil && *a.APIKeyEnc != "") || (a.APIKeyRef != nil && *a.APIKeyRef != "")
}

// ErrInvalidAgent is returned when an agent fails validation.
var ErrInvalidAgent = errors.New("invalid agent")

// Validate checks the invariants that must hold before an agent is persisted.
func (a *Agent) Validate() error {
	if strings.TrimSpace(a.ID) == "" {
		return errors.Join(ErrInvalidAgent, errors.New("id is required"))
	}
	if strings.TrimSpace(a.Name) == "" {
		return errors.Join(ErrInvalidAgent, errors.New("name is required"))
	}
	if !ValidRuntime(a.Runtime) {
		return errors.Join(ErrInvalidAgent, errors.New("unknown runtime"))
	}
	if a.Runtime.IsHTTP() && strings.TrimSpace(a.BaseURL) == "" {
		return errors.Join(ErrInvalidAgent, errors.New("base url is required"))
	}
	if a.Runtime.IsCLI() && !a.IsLocal() {
		return errors.Join(ErrInvalidAgent, errors.New("a CLI agent must be hosted by a device"))
	}
	if a.SettingsJSON != "" && !strings.HasPrefix(strings.TrimSpace(a.SettingsJSON), "{") {
		return errors.Join(ErrInvalidAgent, errors.New("settings must be a JSON object"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (a *Agent) SyncID() string           { return a.ID }
func (a *Agent) SyncVersion() int64       { return a.Version }
func (a *Agent) SyncUpdatedAt() time.Time { return a.UpdatedAt }
func (a *Agent) SyncDeleted() bool        { return a.DeletedAt != nil }
func (a *Agent) SyncDirty() bool          { return a.Dirty }
