package syncserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"companion/core/bridge"
	"companion/core/domain"
	"companion/core/store"
)

// eventLog records core events by name for assertions.
type eventLog struct {
	mu     sync.Mutex
	events map[string][][]byte
}

func (l *eventLog) OnEvent(name string, payload []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.events == nil {
		l.events = map[string][][]byte{}
	}
	l.events[name] = append(l.events[name], append([]byte(nil), payload...))
}

func (l *eventLog) tokens() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	for _, p := range l.events["llm.token"] {
		var e struct {
			Text string `json:"text"`
		}
		json.Unmarshal(p, &e)
		b.WriteString(e.Text)
	}
	return b.String()
}

func newCore(t *testing.T, platform string, canHost bool) (*bridge.Core, *eventLog) {
	t.Helper()
	st, err := store.Open(":memory:", domain.SystemClock{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := bridge.New(st)
	log := &eventLog{}
	c.SetEventHandler(log)
	c.SetDeviceInfo(platform, strings.ToUpper(platform)+" device", canHost)
	return c, log
}

func invoke(t *testing.T, c *bridge.Core, method string, args any) []byte {
	t.Helper()
	var payload []byte
	if args != nil {
		payload, _ = json.Marshal(args)
	}
	out, err := c.Invoke(method, payload)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	return out
}

// TestRelayDrivesHostedAgentFromAnotherDevice is the whole PLAN-agents.md §5 flow in one
// process: a "desktop" core installs an agent hosted by it and syncs; a "phone" core syncs,
// sees the agent, sends a chat turn; the turn runs on the desktop (against a fake model
// server), tokens stream back to the phone, and the persisted reply reaches it via sync.
func TestRelayDrivesHostedAgentFromAnotherDevice(t *testing.T) {
	ts := newServer(t)
	tok := register(t, ts.URL, "relay@x.co", "password")

	// A fake OpenAI-compatible model the desktop's agent talks to.
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/models") {
			w.Write([]byte(`{"data":[{"id":"fake-1"}]}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"Hello from \"},\"finish_reason\":null}]}\n\n"))
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"the desktop\"},\"finish_reason\":\"stop\"}]}\n\n"))
		w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer model.Close()

	desktop, _ := newCore(t, "macos", true)
	phone, phoneLog := newCore(t, "ios", false)

	invoke(t, desktop, "sync.configure", map[string]any{"baseUrl": ts.URL, "token": tok})
	invoke(t, phone, "sync.configure", map[string]any{"baseUrl": ts.URL, "token": tok})

	// Desktop installs a local server agent (an "Ollama" found on it) and syncs it up.
	out := invoke(t, desktop, "agents.install", map[string]any{"runtime": "ollama", "name": "Ollama", "baseUrl": model.URL + "/v1"})
	var agent struct {
		ID           string `json:"id"`
		HostDeviceID string `json:"hostDeviceId"`
		HostedHere   bool   `json:"hostedHere"`
	}
	json.Unmarshal(out, &agent)
	if !agent.HostedHere || agent.HostDeviceID == "" {
		t.Fatalf("agent not hosted by desktop: %+v", agent)
	}
	invoke(t, desktop, "sync.run", nil)

	// Wait for the desktop's inbox to be open (registration + hosting run async after configure).
	deadline := time.Now().Add(5 * time.Second)
	for {
		invoke(t, phone, "sync.run", nil)
		time.Sleep(100 * time.Millisecond) // presence refresh is async after sync.run
		list := invoke(t, phone, "agents.list", nil)
		var agents []struct {
			ID         string `json:"id"`
			Online     bool   `json:"online"`
			HostedHere bool   `json:"hostedHere"`
			HostName   string `json:"hostName"`
		}
		json.Unmarshal(list, &agents)
		if len(agents) == 1 && agents[0].Online {
			if agents[0].HostedHere || agents[0].HostName != "MACOS device" {
				t.Fatalf("phone's view of the agent is wrong: %+v", agents[0])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("phone never saw the desktop online: %s", list)
		}
	}

	// Phone asks the host for the model list through the relay.
	models := invoke(t, phone, "agents.models", map[string]any{"agentId": agent.ID})
	if string(models) != `["fake-1"]` {
		t.Fatalf("remote models = %s", models)
	}

	// Phone sends a turn.
	chatOut := invoke(t, phone, "chats.create", map[string]any{})
	var chat struct {
		ID string `json:"id"`
	}
	json.Unmarshal(chatOut, &chat)
	sendOut := invoke(t, phone, "chats.send", map[string]any{"chatId": chat.ID, "text": "hi there", "agentId": agent.ID, "model": "fake-1"})
	var ack struct {
		Remote  bool `json:"remote"`
		Working bool `json:"working"`
	}
	json.Unmarshal(sendOut, &ack)
	if !ack.Remote || !ack.Working {
		t.Fatalf("send ack = %+v, want remote+working", ack)
	}

	// The reply is persisted by the desktop and arrives on the phone via sync.
	deadline = time.Now().Add(10 * time.Second)
	var final string
	for time.Now().Before(deadline) {
		got := invoke(t, phone, "chats.get", map[string]any{"id": chat.ID})
		var d struct {
			Working  bool `json:"working"`
			Messages []struct {
				Role string `json:"role"`
				Text string `json:"text"`
			} `json:"messages"`
		}
		json.Unmarshal(got, &d)
		if !d.Working && len(d.Messages) >= 2 && d.Messages[len(d.Messages)-1].Role == "assistant" {
			final = d.Messages[len(d.Messages)-1].Text
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if final != "Hello from the desktop" {
		t.Fatalf("phone never got the reply; final=%q tokens=%q", final, phoneLog.tokens())
	}
	if got := phoneLog.tokens(); got != "Hello from the desktop" {
		t.Errorf("phone should have streamed the tokens live, got %q", got)
	}
	// Exactly one user turn: the host ran with resume and did not re-append it.
	got := invoke(t, phone, "chats.get", map[string]any{"id": chat.ID})
	var d struct {
		Messages []struct {
			Role string `json:"role"`
		} `json:"messages"`
	}
	json.Unmarshal(got, &d)
	users := 0
	for _, m := range d.Messages {
		if m.Role == "user" {
			users++
		}
	}
	if users != 1 || len(d.Messages) != 2 {
		t.Errorf("transcript = %+v, want one user + one assistant turn", d.Messages)
	}

	// Disconnecting the desktop takes its agent offline for the phone.
	invoke(t, desktop, "sync.disconnect", nil)
	deadline = time.Now().Add(5 * time.Second)
	for {
		invoke(t, phone, "sync.run", nil)
		time.Sleep(100 * time.Millisecond)
		list := invoke(t, phone, "agents.list", nil)
		var agents []struct {
			Online bool `json:"online"`
		}
		json.Unmarshal(list, &agents)
		if len(agents) == 1 && !agents[0].Online {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("agent still online after host disconnected: %s", list)
		}
	}
	if _, err := phone.Invoke("chats.send", mustJSONArgs(map[string]any{"chatId": chat.ID, "text": "again", "agentId": agent.ID, "model": "fake-1"})); err == nil || !strings.Contains(err.Error(), "offline") {
		t.Errorf("send to offline host should fail clearly, got %v", err)
	}
}

func mustJSONArgs(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
