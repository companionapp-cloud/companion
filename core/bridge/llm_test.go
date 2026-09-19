package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"companion/core/agents"
)

// fakeSecrets is an in-memory SecretStore standing in for the OS keychain.
type fakeSecrets struct{ m map[string]string }

func newFakeSecrets() *fakeSecrets { return &fakeSecrets{m: map[string]string{}} }

func (f *fakeSecrets) GetSecret(ref string) (string, error) { return f.m[ref], nil }
func (f *fakeSecrets) SetSecret(ref, value string) error    { f.m[ref] = value; return nil }
func (f *fakeSecrets) DeleteSecret(ref string) error        { delete(f.m, ref); return nil }

// payloadHandler records event names and their JSON payloads.
type payloadHandler struct {
	names    []string
	payloads map[string][][]byte
}

func newPayloadHandler() *payloadHandler {
	return &payloadHandler{payloads: map[string][][]byte{}}
}

func (h *payloadHandler) OnEvent(name string, payload []byte) {
	h.names = append(h.names, name)
	cp := append([]byte(nil), payload...)
	h.payloads[name] = append(h.payloads[name], cp)
}

func (h *payloadHandler) count(name string) int { return len(h.payloads[name]) }

// sseChatServer replies to each /chat/completions call with the next OpenAI SSE script.
func sseChatServer(t *testing.T, scripts ...string) *httptest.Server {
	t.Helper()
	call := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if call < len(scripts) {
			w.Write([]byte(scripts[call]))
		}
		call++
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestChatsSendNoConfig surfaces a clear error when nothing is configured (the end-to-end
// chat path is covered by TestChatsBackgroundRun).
func TestChatsSendNoConfig(t *testing.T) {
	c, _ := newTestCore(t)
	chatOut, err := c.Invoke("chats.create", mustJSON(map[string]any{}))
	if err != nil {
		t.Fatalf("chats.create: %v", err)
	}
	var chat struct {
		ID string `json:"id"`
	}
	json.Unmarshal(chatOut, &chat)

	_, err = c.Invoke("chats.send", mustJSON(map[string]any{"chatId": chat.ID, "text": "hi"}))
	if err == nil || !strings.Contains(err.Error(), "no LLM configured") {
		t.Errorf("expected no-config error, got %v", err)
	}
}

// TestAgentInstallStoresKeyInKeychain verifies that, without E2EE, the API key goes to the
// device keychain (not the DB) and the row keeps only a ref.
func TestAgentInstallStoresKeyInKeychain(t *testing.T) {
	c, _ := newTestCore(t)
	secrets := newFakeSecrets()
	c.SetSecretStore(secrets)

	out, err := c.Invoke("agents.install", mustJSON(map[string]any{
		"name": "Claude", "runtime": "anthropic-api", "apiKey": "sk-secret",
	}))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var cfg struct {
		ID        string  `json:"id"`
		APIKeyRef *string `json:"apiKeyRef"`
	}
	json.Unmarshal(out, &cfg)
	if cfg.APIKeyRef == nil {
		t.Fatal("expected an api key ref")
	}
	if got := secrets.m[*cfg.APIKeyRef]; got != "sk-secret" {
		t.Errorf("key not stored in keychain, got %q", got)
	}
	// Deleting the agent removes the key too.
	if _, err := c.Invoke("agents.remove", mustJSON(map[string]any{"id": cfg.ID})); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := secrets.m[*cfg.APIKeyRef]; ok {
		t.Error("key should have been deleted with the config")
	}
}

// sse wraps chat-completion JSON chunks into an SSE body ending with [DONE].
func sse(chunks ...string) string {
	var b strings.Builder
	for _, ch := range chunks {
		b.WriteString("data: ")
		b.WriteString(ch)
		b.WriteString("\n\n")
	}
	b.WriteString("data: [DONE]\n\n")
	return b.String()
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// TestLLMModelsList proves the bridge fetches a config's live model list from its endpoint,
// so the composer can offer models without them being baked into the config.
func TestLLMModelsList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/models") {
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"id":"qwen2.5"},{"id":"llama3.1"}]}`))
	}))
	t.Cleanup(srv.Close)

	c, _ := newTestCore(t)
	out, err := c.Invoke("agents.install", mustJSON(map[string]any{
		"name": "Local", "runtime": "openai-compatible", "baseUrl": srv.URL + "/v1", "isDefault": true,
	}))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var cfg struct {
		ID string `json:"id"`
	}
	json.Unmarshal(out, &cfg)

	got, err := c.Invoke("agents.models", mustJSON(map[string]any{"agentId": cfg.ID}))
	if err != nil {
		t.Fatalf("models.list: %v", err)
	}
	var models []string
	json.Unmarshal(got, &models)
	if len(models) != 2 || models[0] != "llama3.1" || models[1] != "qwen2.5" {
		t.Errorf("models = %v, want sorted [llama3.1 qwen2.5]", models)
	}
}

// TestAgentModelsWithoutTheKeyHere covers an agent whose row names a key ref that this device's
// keychain doesn't hold (the key was saved on another device of an unencrypted account, or lost).
// Secret stores return "" for a missing ref; that must surface as a missing key, not a request
// the API rejects with a bare 401.
func TestAgentModelsWithoutTheKeyHere(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, `{"type":"error","error":{"type":"authentication_error","message":"x-api-key header is required"}}`, http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)

	c, _ := newTestCore(t)
	secrets := newFakeSecrets()
	c.SetSecretStore(secrets)
	out, err := c.Invoke("agents.install", mustJSON(map[string]any{
		"name": "Anthropic", "runtime": "anthropic-api", "baseUrl": srv.URL, "apiKey": "sk-elsewhere",
	}))
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	var a struct {
		ID     string `json:"id"`
		HasKey bool   `json:"hasKey"`
	}
	json.Unmarshal(out, &a)
	if !a.HasKey {
		t.Error("hasKey should be true while the keychain holds the key")
	}
	clear(secrets.m)

	_, err = c.Invoke("agents.models", mustJSON(map[string]any{"agentId": a.ID}))
	if err == nil || !strings.Contains(err.Error(), "Anthropic has no API key on this device") {
		t.Fatalf("models error = %v, want the missing-key error", err)
	}
	if calls != 0 {
		t.Errorf("the API was called %d time(s) without a key", calls)
	}
	list, _ := c.Invoke("agents.list", nil)
	var views []struct {
		HasKey bool `json:"hasKey"`
	}
	json.Unmarshal(list, &views)
	if len(views) != 1 || views[0].HasKey {
		t.Errorf("agents.list = %s, want hasKey false", list)
	}
}

// TestAgentInstallEncryptsKeyOnE2EEAccount verifies that with the master key unlocked the API
// key rides in the synced row (apiKeyEnc) rather than the device keychain.
func TestAgentInstallEncryptsKeyOnE2EEAccount(t *testing.T) {
	c, _ := newTestCore(t)
	secrets := newFakeSecrets()
	c.SetSecretStore(secrets)
	c.masterKey = make([]byte, 32)

	out, err := c.Invoke("agents.install", mustJSON(map[string]any{"name": "OpenAI", "runtime": "openai-api", "apiKey": "sk-e2ee"}))
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	var a struct {
		ID        string  `json:"id"`
		APIKeyEnc *string `json:"apiKeyEnc"`
		APIKeyRef *string `json:"apiKeyRef"`
		BaseURL   string  `json:"baseUrl"`
		IsDefault bool    `json:"isDefault"`
	}
	json.Unmarshal(out, &a)
	if a.APIKeyEnc == nil || *a.APIKeyEnc != "sk-e2ee" || a.APIKeyRef != nil {
		t.Errorf("key should be on the row for an E2EE account: %+v", a)
	}
	if len(secrets.m) != 0 {
		t.Error("keychain should be untouched on an E2EE account")
	}
	if a.BaseURL != "https://api.openai.com/v1" || !a.IsDefault {
		t.Errorf("runtime defaults not applied: %+v", a)
	}
}

// TestAgentInstallLocalPinsHost verifies a discovered local tool is pinned to this device and
// that discovery reports it as installed afterwards.
func TestAgentInstallLocalPinsHost(t *testing.T) {
	c, _ := newTestCore(t)
	c.SetDeviceInfo("macos", "Test Mac", true)
	c.SetAgentDiscoverer(fakeDiscoverer{{Runtime: "claude-cli", Name: "Claude Code", Path: "/usr/local/bin/claude", Status: "ready"}})

	out, err := c.Invoke("agents.install", mustJSON(map[string]any{
		"name": "Claude Code", "runtime": "claude-cli", "binaryPath": "/usr/local/bin/claude", "binaryVersion": "2.0.0",
	}))
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	var a struct {
		ID           string  `json:"id"`
		HostDeviceID *string `json:"hostDeviceId"`
		HostName     *string `json:"hostName"`
		HostedHere   bool    `json:"hostedHere"`
		Online       bool    `json:"online"`
	}
	json.Unmarshal(out, &a)
	me, _ := c.store.EnsureDeviceID()
	if a.HostDeviceID == nil || *a.HostDeviceID != me || a.HostName == nil || *a.HostName != "Test Mac" || !a.HostedHere {
		t.Errorf("local agent not pinned to this device: %+v", a)
	}
	if a.Online {
		t.Error("a CLI agent with no runner factory injected should read as offline")
	}

	disc, err := c.Invoke("agents.discover", nil)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	var found []struct {
		Runtime          string  `json:"runtime"`
		InstalledAgentID *string `json:"installedAgentId"`
	}
	json.Unmarshal(disc, &found)
	if len(found) != 1 || found[0].InstalledAgentID == nil || *found[0].InstalledAgentID != a.ID {
		t.Errorf("discovery should mark the tool installed: %+v", found)
	}

	// A device's rename propagates to the host label on its agents.
	if _, err := c.Invoke("devices.rename", mustJSON(map[string]any{"name": "Studio"})); err != nil {
		t.Fatalf("rename: %v", err)
	}
	got, _ := c.store.Agents.Get(a.ID)
	if got.HostName == nil || *got.HostName != "Studio" {
		t.Errorf("host name not refreshed after rename: %v", got.HostName)
	}
}

// TestAgentsDiscoverWithoutDiscoverer proves web/mobile shells get an empty list, not an error.
func TestAgentsDiscoverWithoutDiscoverer(t *testing.T) {
	c, _ := newTestCore(t)
	out, err := c.Invoke("agents.discover", nil)
	if err != nil || string(out) != "[]" {
		t.Errorf("discover = %s, %v; want []", out, err)
	}
}

type fakeDiscoverer []agents.Discovered

func (f fakeDiscoverer) Discover(context.Context) ([]agents.Discovered, error) {
	return append([]agents.Discovered(nil), f...), nil
}
