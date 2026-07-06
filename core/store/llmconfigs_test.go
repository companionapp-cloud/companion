//go:build !js

package store

import (
	"testing"
	"time"

	"companion/core/domain"
)

func TestLLMConfigsCRUDAndDefault(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	local, err := s.LLMConfigs.Create(CreateLLMConfigInput{
		Scope: domain.ScopeDevice, Name: "Local (Ollama)",
		BaseURL: "http://localhost:11434/v1", Provider: domain.ProviderOpenAI, Model: "qwen2.5",
		IsDefault: true,
	})
	if err != nil {
		t.Fatalf("create local: %v", err)
	}
	if !local.IsDefault {
		t.Error("first config should be default")
	}

	ref := "llm." + "cloud"
	cloud, err := s.LLMConfigs.Create(CreateLLMConfigInput{
		Scope: domain.ScopeAccount, Name: "Claude",
		BaseURL: "https://api.anthropic.com", Provider: domain.ProviderAnthropic, Model: "claude-opus-4-8",
		APIKeyRef: &ref, IsDefault: true,
	})
	if err != nil {
		t.Fatalf("create cloud: %v", err)
	}

	// Creating a second default must demote the first.
	got, err := s.LLMConfigs.Default()
	if err != nil {
		t.Fatalf("default: %v", err)
	}
	if got.ID != cloud.ID {
		t.Errorf("default = %q, want cloud %q", got.ID, cloud.ID)
	}
	reloadLocal, _ := s.LLMConfigs.Get(local.ID)
	if reloadLocal.IsDefault {
		t.Error("first config should have been demoted")
	}

	// Switch the default back and confirm exclusivity.
	if err := s.LLMConfigs.SetDefault(local.ID); err != nil {
		t.Fatalf("set default: %v", err)
	}
	if d, _ := s.LLMConfigs.Default(); d.ID != local.ID {
		t.Errorf("default not switched, got %q", d.ID)
	}
	list, _ := s.LLMConfigs.List()
	defaults := 0
	for _, c := range list {
		if c.IsDefault {
			defaults++
		}
	}
	if defaults != 1 {
		t.Errorf("expected exactly one default, got %d", defaults)
	}

	// Update + soft delete.
	if _, err := s.LLMConfigs.Update(cloud.ID, UpdateLLMConfigInput{Model: strptr("claude-sonnet-5")}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if u, _ := s.LLMConfigs.Get(cloud.ID); u.Model != "claude-sonnet-5" {
		t.Errorf("model not updated: %q", u.Model)
	}
	if err := s.LLMConfigs.Delete(cloud.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.LLMConfigs.Get(cloud.ID); err != ErrNotFound {
		t.Errorf("deleted config should be gone, got %v", err)
	}
}

func TestLLMConfigsValidation(t *testing.T) {
	s := newTestStore(t, nil)
	if _, err := s.LLMConfigs.Create(CreateLLMConfigInput{
		Scope: "bogus", Name: "x", BaseURL: "u", Provider: domain.ProviderOpenAI, Model: "m",
	}); err == nil {
		t.Error("expected scope validation error")
	}
	if _, err := s.LLMConfigs.Create(CreateLLMConfigInput{
		Scope: domain.ScopeDevice, Name: "x", BaseURL: "u", Provider: "weird", Model: "m",
	}); err == nil {
		t.Error("expected provider validation error")
	}
}

func strptr(s string) *string { return &s }
