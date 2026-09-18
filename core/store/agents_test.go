//go:build !js

package store

import (
	"testing"
	"time"

	"companion/core/domain"
)

func TestAgentsCRUDAndDefault(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	dev := "dev-1"
	host := "Chris's MacBook"
	local, err := s.Agents.Create(CreateAgentInput{
		Name: "Ollama", Runtime: domain.RuntimeOllama, HostDeviceID: &dev, HostName: &host, IsDefault: true,
	})
	if err != nil {
		t.Fatalf("create local: %v", err)
	}
	if !local.IsDefault {
		t.Error("first agent should be default")
	}
	if local.BaseURL != domain.RuntimeOllama.DefaultBaseURL() {
		t.Errorf("empty base url should take the runtime default, got %q", local.BaseURL)
	}
	if !local.IsLocal() || !local.IsHostedBy(dev) || local.Scope() != domain.ScopeDevice {
		t.Errorf("local agent hosting not derived: %+v", local)
	}

	ref := "llm.cloud"
	cloud, err := s.Agents.Create(CreateAgentInput{
		Name: "Claude", Runtime: domain.RuntimeAnthropicAPI, APIKeyRef: &ref, IsDefault: true,
	})
	if err != nil {
		t.Fatalf("create cloud: %v", err)
	}
	if cloud.Scope() != domain.ScopeAccount || !cloud.HasAPIKey() {
		t.Errorf("cloud agent state: %+v", cloud)
	}

	// Creating a second default must demote the first.
	got, err := s.Agents.Default()
	if err != nil {
		t.Fatalf("default: %v", err)
	}
	if got.ID != cloud.ID {
		t.Errorf("default = %q, want cloud %q", got.ID, cloud.ID)
	}
	if reload, _ := s.Agents.Get(local.ID); reload.IsDefault {
		t.Error("first agent should have been demoted")
	}

	// Switch the default back and confirm exclusivity.
	if err := s.Agents.SetDefault(local.ID); err != nil {
		t.Fatalf("set default: %v", err)
	}
	list, _ := s.Agents.List()
	defaults := 0
	for _, a := range list {
		if a.IsDefault {
			defaults++
		}
	}
	if defaults != 1 || list[0].ID != local.ID {
		t.Errorf("expected exactly one default sorted first, got %d (%+v)", defaults, list)
	}

	// Update + soft delete.
	if !cloud.AllowWrite || cloud.AllowSystem {
		t.Errorf("defaults should be write tools on, system access off: %+v", cloud)
	}
	yes, no := true, false
	if _, err := s.Agents.Update(cloud.ID, UpdateAgentInput{BaseURL: strptr("https://proxy.example.com"), AllowWrite: &no, AllowSystem: &yes}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if u, _ := s.Agents.Get(cloud.ID); u.BaseURL != "https://proxy.example.com" || u.AllowWrite || !u.AllowSystem {
		t.Errorf("update not applied: %+v", u)
	}
	if err := s.Agents.Delete(cloud.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.Agents.Get(cloud.ID); err != ErrNotFound {
		t.Errorf("deleted agent should be gone, got %v", err)
	}
	// The tombstone is still dirty for sync.
	dirty, _ := s.Agents.Dirty()
	found := false
	for _, a := range dirty {
		if a.ID == cloud.ID && a.DeletedAt != nil {
			found = true
		}
	}
	if !found {
		t.Error("tombstone should be in the dirty set")
	}
}

func TestAgentsValidation(t *testing.T) {
	s := newTestStore(t, nil)
	if _, err := s.Agents.Create(CreateAgentInput{Name: "x", Runtime: "weird"}); err == nil {
		t.Error("expected runtime validation error")
	}
	// A CLI agent needs a host.
	if _, err := s.Agents.Create(CreateAgentInput{Name: "Claude Code", Runtime: domain.RuntimeClaudeCLI}); err == nil {
		t.Error("expected host validation error for CLI agent")
	}
	dev := "dev"
	if _, err := s.Agents.Create(CreateAgentInput{Name: "Claude Code", Runtime: domain.RuntimeClaudeCLI, HostDeviceID: &dev}); err != nil {
		t.Errorf("hosted CLI agent should be valid: %v", err)
	}
	// A manual server needs a URL.
	if _, err := s.Agents.Create(CreateAgentInput{Name: "LAN", Runtime: domain.RuntimeOpenAICompat}); err == nil {
		t.Error("expected base url validation error")
	}
}

func TestAgentsSyncRoundTripAndClaim(t *testing.T) {
	s := newTestStore(t, nil)
	// A legacy device-scoped row written by a pre-agents client: no host, scope=device.
	if _, err := s.db.Exec(`INSERT INTO llm_configs (id, scope, name, base_url, provider, runtime, created_at, updated_at, version, dirty)
		VALUES ('legacy', 'device', 'Local (Ollama)', 'http://localhost:11434/v1', 'openai-compatible', 'ollama', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0);`); err != nil {
		t.Fatal(err)
	}
	n, err := s.Agents.ClaimUnhosted("dev-9", "Studio")
	if err != nil || n != 1 {
		t.Fatalf("claim = %d, %v", n, err)
	}
	a, _ := s.Agents.Get("legacy")
	if !a.IsHostedBy("dev-9") || derefStr(a.HostName) != "Studio" || !a.Dirty {
		t.Errorf("legacy row not claimed: %+v", a)
	}

	// Apply a server row and read it back through Decode/GetAny.
	raw := []byte(`{"id":"srv","name":"Codex","runtime":"codex-cli","baseUrl":"","hostDeviceId":"dev-9","allowWrite":true,"allowSystem":true,
		"settingsJson":"{}","isDefault":false,"createdAt":"2026-02-01T00:00:00Z","updatedAt":"2026-02-01T00:00:00Z","version":3,"dirty":false}`)
	dec, err := s.Agents.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Agents.Apply(dec); err != nil {
		t.Fatal(err)
	}
	got, err := s.Agents.GetAny("srv")
	if err != nil {
		t.Fatal(err)
	}
	if got.Runtime != domain.RuntimeCodexCLI || !got.AllowWrite || !got.AllowSystem || got.Version != 3 || got.Dirty {
		t.Errorf("applied row mismatch: %+v", got)
	}
	if err := s.Agents.MarkPushed("legacy", 7); err != nil {
		t.Fatal(err)
	}
	if l, _ := s.Agents.GetAny("legacy"); l.Dirty || l.Version != 7 {
		t.Errorf("mark pushed not applied: %+v", l)
	}
}

func strptr(s string) *string { return &s }
