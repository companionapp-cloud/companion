package domain

import (
	"errors"
	"strings"
	"time"
)

// LLM config scopes (PLAN §6.8). Device configs point at a local model on this machine and
// never sync; account configs are cloud providers whose row syncs and whose API key lives
// in the OS keychain.
const (
	ScopeDevice  = "device"
	ScopeAccount = "account"
)

// LLM provider kinds. "openai-compatible" covers OpenAI, Ollama, LM Studio, and any other
// server speaking the Chat Completions API; "anthropic" is the Messages API.
const (
	ProviderOpenAI    = "openai-compatible"
	ProviderAnthropic = "anthropic"
)

// LLMConfig is one configured model the user can chat with (PLAN §4.1). The API key itself
// is never stored here — APIKeyRef is a handle into the OS keychain.
type LLMConfig struct {
	ID        string     `json:"id"`
	Scope     string     `json:"scope"`
	Name      string     `json:"name"`
	BaseURL   string     `json:"baseUrl"`
	Provider  string     `json:"provider"`
	Model     string     `json:"model"`
	APIKeyRef *string    `json:"apiKeyRef,omitempty"`
	IsDefault bool       `json:"isDefault"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// ErrInvalidLLMConfig is returned when a config fails validation.
var ErrInvalidLLMConfig = errors.New("invalid llm config")

// Validate checks the invariants that must hold before a config is persisted.
func (c *LLMConfig) Validate() error {
	if strings.TrimSpace(c.ID) == "" {
		return errors.Join(ErrInvalidLLMConfig, errors.New("id is required"))
	}
	if strings.TrimSpace(c.Name) == "" {
		return errors.Join(ErrInvalidLLMConfig, errors.New("name is required"))
	}
	if strings.TrimSpace(c.BaseURL) == "" {
		return errors.Join(ErrInvalidLLMConfig, errors.New("base url is required"))
	}
	if strings.TrimSpace(c.Model) == "" {
		return errors.Join(ErrInvalidLLMConfig, errors.New("model is required"))
	}
	if c.Scope != ScopeDevice && c.Scope != ScopeAccount {
		return errors.Join(ErrInvalidLLMConfig, errors.New("scope must be device or account"))
	}
	if c.Provider != ProviderOpenAI && c.Provider != ProviderAnthropic {
		return errors.Join(ErrInvalidLLMConfig, errors.New("unknown provider"))
	}
	return nil
}
