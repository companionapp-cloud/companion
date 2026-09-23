package bridge

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"companion/core/domain"
)

// aiServer is a fake OpenAI-compatible endpoint: it records each chat request body and answers
// with the given streamed content, and lists one model.
type aiServer struct {
	*httptest.Server
	mu     sync.Mutex
	bodies []string
}

func newAIServer(t *testing.T, reply string) *aiServer {
	t.Helper()
	s := &aiServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/models") {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[{"id":"listed-model"}]}`))
			return
		}
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.bodies = append(s.bodies, string(body))
		s.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		// Stream the reply in two chunks to exercise ai.delta.
		half := len(reply) / 2
		for half > 0 && half < len(reply) && (reply[half]&0xC0) == 0x80 {
			half++
		}
		chunk := func(text string) string {
			b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": text}}}})
			return string(b)
		}
		w.Write([]byte(sse(chunk(reply[:half]), chunk(reply[half:]))))
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *aiServer) lastBody() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.bodies) == 0 {
		return ""
	}
	return s.bodies[len(s.bodies)-1]
}

func installAIAgent(t *testing.T, c *Core, baseURL string) {
	t.Helper()
	c.SetSecretStore(newFakeSecrets())
	if _, err := c.Invoke("agents.install", mustJSON(map[string]any{
		"name": "Local", "runtime": "openai-compatible", "baseUrl": baseURL + "/v1", "isDefault": true,
	})); err != nil {
		t.Fatalf("agents.install: %v", err)
	}
}

type aiEvents struct {
	deltas []string
	done   map[string]any
	err    string
}

// runAI invokes ai.run and waits for its terminal event.
func runAI(t *testing.T, c *Core, args map[string]any) aiEvents {
	t.Helper()
	runID := args["runId"].(string)
	var (
		mu  sync.Mutex
		got aiEvents
	)
	finished := make(chan struct{})
	untap := c.tapEvents(func(name string, payload []byte) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		if p["runId"] != runID {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch name {
		case eventAIDelta:
			got.deltas = append(got.deltas, p["text"].(string))
		case eventAIDone:
			got.done = p
			close(finished)
		case eventAIError:
			got.err = p["error"].(string)
			close(finished)
		}
	})
	defer untap()
	if _, err := c.Invoke("ai.run", mustJSON(args)); err != nil {
		t.Fatalf("ai.run: %v", err)
	}
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("ai run never finished")
	}
	mu.Lock()
	defer mu.Unlock()
	return got
}

func TestAIStatus(t *testing.T) {
	c, _ := newTestCore(t)
	out, err := c.Invoke("ai.status", nil)
	if err != nil {
		t.Fatalf("ai.status: %v", err)
	}
	var st struct {
		Enabled   bool   `json:"enabled"`
		Reason    string `json:"reason"`
		AgentName string `json:"agentName"`
	}
	json.Unmarshal(out, &st)
	if st.Enabled || !strings.Contains(st.Reason, "no LLM configured") {
		t.Errorf("no agents: got %+v", st)
	}

	srv := newAIServer(t, "")
	installAIAgent(t, c, srv.URL)
	out, _ = c.Invoke("ai.status", nil)
	json.Unmarshal(out, &st)
	if !st.Enabled || st.AgentName != "Local" {
		t.Errorf("with an agent: got %+v", st)
	}
}

// A cloud agent whose key isn't on this device (it synced from a device that kept the key in
// its own keychain) can't run assists; status says why.
func TestAIStatusMissingKey(t *testing.T) {
	c, _ := newTestCore(t)
	c.SetSecretStore(newFakeSecrets())
	if _, err := c.Invoke("agents.install", mustJSON(map[string]any{
		"name": "Claude", "runtime": "anthropic-api", "apiKey": "sk-x", "isDefault": true,
	})); err != nil {
		t.Fatalf("agents.install: %v", err)
	}
	c.SetSecretStore(newFakeSecrets())
	out, _ := c.Invoke("ai.status", nil)
	var st struct {
		Enabled bool   `json:"enabled"`
		Reason  string `json:"reason"`
	}
	json.Unmarshal(out, &st)
	if st.Enabled || !strings.Contains(st.Reason, "no API key") {
		t.Errorf("got %+v", st)
	}
}

func TestAIRunStreamsText(t *testing.T) {
	srv := newAIServer(t, "The gist.\n\n- One\n- Two")
	c, _ := newTestCore(t)
	installAIAgent(t, c, srv.URL)

	got := runAI(t, c, map[string]any{
		"runId": "r1", "task": "summarize", "text": "A long note about [[task:abc|a task]].", "title": "Weekly", "model": "m1",
	})
	if got.err != "" {
		t.Fatalf("error: %s", got.err)
	}
	if len(got.deltas) == 0 {
		t.Error("summarize should stream deltas")
	}
	if got.done["text"] != "The gist.\n\n- One\n- Two" || got.done["model"] != "m1" || got.done["task"] != "summarize" {
		t.Errorf("done = %+v", got.done)
	}
	body := srv.lastBody()
	for _, want := range []string{`"model":"m1"`, "Summarize this note", "Note title: Weekly", "[[task:abc|a task]]"} {
		if !strings.Contains(body, want) {
			t.Errorf("request missing %q: %s", want, body)
		}
	}
	if strings.Contains(body, `"tools"`) {
		t.Error("editor assists must not offer tools")
	}
}

// Without a model in the request, the run uses the model the user last chatted with on the
// agent, falling back to the first one it lists.
func TestAIRunDefaultModel(t *testing.T) {
	srv := newAIServer(t, "ok")
	c, _ := newTestCore(t)
	installAIAgent(t, c, srv.URL)

	got := runAI(t, c, map[string]any{"runId": "r1", "task": "critique", "text": "Draft."})
	if got.done["model"] != "listed-model" {
		t.Errorf("fallback model = %v", got.done["model"])
	}

	ch, err := c.store.Chats.Create("", nil)
	if err != nil {
		t.Fatal(err)
	}
	m := "chat-model"
	if err := c.store.Chats.SetModel(ch.ID, &m); err != nil {
		t.Fatal(err)
	}
	got = runAI(t, c, map[string]any{"runId": "r2", "task": "critique", "text": "Draft."})
	if got.done["model"] != "chat-model" {
		t.Errorf("chat model = %v", got.done["model"])
	}
}

func TestAIRunValidation(t *testing.T) {
	srv := newAIServer(t, "")
	c, _ := newTestCore(t)
	installAIAgent(t, c, srv.URL)
	cases := []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"task": "summarize", "text": "x"}, "runId is required"},
		{map[string]any{"runId": "a", "task": "nope", "text": "x"}, "unknown assist"},
		{map[string]any{"runId": "a", "task": "summarize", "text": "  "}, "note is empty"},
		{map[string]any{"runId": "a", "task": "grammar", "text": "", "selection": true}, "selection is empty"},
		{map[string]any{"runId": "a", "task": "generate", "prompt": ""}, "what to write"},
		{map[string]any{"runId": "a", "task": "translate", "text": "x"}, "pick a language"},
		{map[string]any{"runId": "a", "task": "readingLevel", "text": "x"}, "reading level"},
		{map[string]any{"runId": "a", "task": "metadata", "text": "x"}, "no object types"},
	}
	for _, tc := range cases {
		_, err := c.Invoke("ai.run", mustJSON(tc.args))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v: got %v, want %q", tc.args, err, tc.want)
		}
	}
}

func TestAIRunGenerateSendsCursorContext(t *testing.T) {
	srv := newAIServer(t, "New paragraph.")
	c, _ := newTestCore(t)
	installAIAgent(t, c, srv.URL)
	got := runAI(t, c, map[string]any{
		"runId": "g", "task": "generate", "prompt": "write an intro", "model": "m",
		"document": "# Title\n\n" + aiCursorMarker + "\n\nBody",
	})
	if got.done["text"] != "New paragraph." {
		t.Errorf("done = %+v", got.done)
	}
	body := srv.lastBody()
	if !strings.Contains(body, "inserted at "+aiCursorMarker) || !strings.Contains(body, "Instruction: write an intro") {
		t.Errorf("request = %s", body)
	}
}

func TestAIRunGrammarParsesIssues(t *testing.T) {
	reply := "```json\n" + `{"corrected":"Their going home.","issues":[{"original":"Their","suggestion":"They're","explanation":"contraction of they are"},{"original":"ok","suggestion":"ok","explanation":"noop"}]}` + "\n```"
	srv := newAIServer(t, reply)
	c, _ := newTestCore(t)
	installAIAgent(t, c, srv.URL)
	got := runAI(t, c, map[string]any{"runId": "g", "task": "grammar", "text": "Their going home.", "selection": true, "model": "m"})
	if got.err != "" {
		t.Fatalf("error: %s", got.err)
	}
	if len(got.deltas) != 0 {
		t.Error("JSON tasks should not stream")
	}
	res := got.done["result"].(map[string]any)
	issues := res["issues"].([]any)
	if res["corrected"] != "Their going home." || len(issues) != 1 {
		t.Errorf("result = %+v", res)
	}
	if !strings.Contains(srv.lastBody(), "Check this passage") {
		t.Error("a selection should be checked as a passage")
	}
}

func TestAIRunGrammarBadJSON(t *testing.T) {
	srv := newAIServer(t, "Looks fine to me!")
	c, _ := newTestCore(t)
	installAIAgent(t, c, srv.URL)
	got := runAI(t, c, map[string]any{"runId": "g", "task": "grammar", "text": "Hi.", "model": "m"})
	if !strings.Contains(got.err, "expected format") {
		t.Errorf("err = %q", got.err)
	}
}

func createBookType(t *testing.T, c *Core) string {
	t.Helper()
	out, err := c.Invoke("objectTypes.create", mustJSON(map[string]any{
		"name": "Book", "appliesTo": "note",
		"schemaJson": map[string]any{"fields": []map[string]any{
			{"key": "author", "type": "text"},
			{"key": "pages", "type": "number"},
			{"key": "finished", "type": "date"},
			{"key": "status", "type": "select", "options": []string{"Reading", "Done"}},
			{"key": "genres", "type": "multi_select", "options": []string{"Fiction", "History"}},
			{"key": "owned", "type": "checkbox"},
			{"key": "related", "type": "reference", "to": "note"},
		}},
	}))
	if err != nil {
		t.Fatalf("objectTypes.create: %v", err)
	}
	var ot struct {
		ID string `json:"id"`
	}
	json.Unmarshal(out, &ot)
	return ot.ID
}

func TestAIRunMetadataPicksTypeAndSanitizes(t *testing.T) {
	c, _ := newTestCore(t)
	typeID := createBookType(t, c)
	reply := `{"typeId":"` + typeID + `","props":{"author":"Mary Beard","pages":"1,024","finished":"March 3, 2024","status":"done","genres":["history","Poetry"],"owned":"true","related":"x","bogus":1}}`
	srv := newAIServer(t, reply)
	installAIAgent(t, c, srv.URL)

	got := runAI(t, c, map[string]any{"runId": "m", "task": "metadata", "text": "SPQR by Mary Beard...", "model": "m"})
	if got.err != "" {
		t.Fatalf("error: %s", got.err)
	}
	res := got.done["result"].(map[string]any)
	if res["objectTypeId"] != typeID {
		t.Errorf("type = %v", res["objectTypeId"])
	}
	props := res["props"].(map[string]any)
	want := map[string]any{
		"author": "Mary Beard", "pages": 1024.0, "finished": "2024-03-03", "status": "Done",
		"genres": []any{"History"}, "owned": true,
	}
	if len(props) != len(want) {
		t.Errorf("props = %+v", props)
	}
	for k, v := range want {
		if gotV, _ := json.Marshal(props[k]); string(gotV) != string(mustJSON(v)) {
			t.Errorf("%s = %s, want %s", k, gotV, mustJSON(v))
		}
	}
	body := srv.lastBody()
	if strings.Contains(body, "related") {
		t.Error("reference fields should not be offered to the model")
	}
	if !strings.Contains(body, "best fits") {
		t.Error("without a type the model should be asked to pick one")
	}
}

func TestAIRunMetadataNoFit(t *testing.T) {
	c, _ := newTestCore(t)
	createBookType(t, c)
	srv := newAIServer(t, `{"typeId":null,"props":{}}`)
	installAIAgent(t, c, srv.URL)
	got := runAI(t, c, map[string]any{"runId": "m", "task": "metadata", "text": "Groceries: milk", "model": "m"})
	if !strings.Contains(got.err, "none of your object types") {
		t.Errorf("err = %q", got.err)
	}
}

func TestAICancel(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-block:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(block); srv.Close() })
	c, _ := newTestCore(t)
	installAIAgent(t, c, srv.URL)

	var mu sync.Mutex
	var terminal []string
	untap := c.tapEvents(func(name string, _ []byte) {
		if name == eventAIDone || name == eventAIError {
			mu.Lock()
			terminal = append(terminal, name)
			mu.Unlock()
		}
	})
	defer untap()

	if _, err := c.Invoke("ai.run", mustJSON(map[string]any{"runId": "x", "task": "summarize", "text": "t", "model": "m"})); err != nil {
		t.Fatalf("ai.run: %v", err)
	}
	if _, err := c.Invoke("ai.run", mustJSON(map[string]any{"runId": "x", "task": "summarize", "text": "t", "model": "m"})); err == nil {
		t.Error("a second run with a live id should be refused")
	}
	out, _ := c.Invoke("ai.cancel", mustJSON(map[string]any{"runId": "x"}))
	if !strings.Contains(string(out), `"cancelled":true`) {
		t.Errorf("cancel = %s", out)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		c.chatMu.Lock()
		_, live := c.aiRuns["x"]
		c.chatMu.Unlock()
		if !live {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(terminal) != 0 {
		t.Errorf("a cancelled run should emit nothing, got %v", terminal)
	}
}

func TestSanitizePropsDropsInvalid(t *testing.T) {
	schema := domain.ObjectSchema{Fields: []domain.ObjectField{
		{Key: "url", Type: domain.FieldURL},
		{Key: "n", Type: domain.FieldNumber},
		{Key: "d", Type: domain.FieldDate},
		{Key: "s", Type: domain.FieldSelect, Options: []string{"A"}},
		{Key: "t", Type: domain.FieldText},
	}}
	got := sanitizeProps(map[string]any{"url": "not a url", "n": "many", "d": "someday", "s": "B", "t": "  "}, schema)
	if len(got) != 0 {
		t.Errorf("got %+v", got)
	}
}

func TestClipKeepsCursorWindow(t *testing.T) {
	doc := strings.Repeat("a", aiDocumentMax) + aiCursorMarker + strings.Repeat("b", aiDocumentMax)
	out := clip(doc)
	if !strings.Contains(out, aiCursorMarker) {
		t.Error("clip dropped the cursor")
	}
	if len(out) > aiDocumentMax+10 {
		t.Errorf("clip too long: %d", len(out))
	}
}
