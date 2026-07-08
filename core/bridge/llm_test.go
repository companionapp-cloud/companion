package bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

// TestLLMConfigStoresKeyInKeychain verifies the API key goes to the keychain (not the DB)
// and the row keeps only a ref.
func TestLLMConfigStoresKeyInKeychain(t *testing.T) {
	c, _ := newTestCore(t)
	secrets := newFakeSecrets()
	c.SetSecretStore(secrets)

	out, err := c.Invoke("llm.configs.create", mustJSON(map[string]any{
		"scope": "account", "name": "Claude", "baseUrl": "https://api.anthropic.com",
		"provider": "anthropic", "apiKey": "sk-secret",
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
	// Deleting the config removes the key too.
	if _, err := c.Invoke("llm.configs.delete", mustJSON(map[string]any{"id": cfg.ID})); err != nil {
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
	out, err := c.Invoke("llm.configs.create", mustJSON(map[string]any{
		"scope": "device", "name": "Local", "baseUrl": srv.URL + "/v1",
		"provider": "openai-compatible", "isDefault": true,
	}))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var cfg struct {
		ID string `json:"id"`
	}
	json.Unmarshal(out, &cfg)

	got, err := c.Invoke("llm.models.list", mustJSON(map[string]any{"configId": cfg.ID}))
	if err != nil {
		t.Fatalf("models.list: %v", err)
	}
	var models []string
	json.Unmarshal(got, &models)
	if len(models) != 2 || models[0] != "llama3.1" || models[1] != "qwen2.5" {
		t.Errorf("models = %v, want sorted [llama3.1 qwen2.5]", models)
	}
}
