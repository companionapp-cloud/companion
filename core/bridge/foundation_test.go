package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"companion/core/agents"
	"companion/core/llm"
)

// fakeFoundation stands in for the desktop's Apple Intelligence host: its provider runs tools
// inline (the way Foundation Models does) by asking the engine's invoker mid-reply.
type fakeFoundation struct {
	mu    sync.Mutex
	tools []string
	sys   string
	opts  agents.FoundationOptions
}

func (f *fakeFoundation) Provider(opts agents.FoundationOptions) llm.Provider {
	return &fakeInlineProvider{f: f, opts: opts}
}

type fakeInlineProvider struct {
	f    *fakeFoundation
	opts agents.FoundationOptions
}

// waitChatIdle waits for a chat's background turn to finish.
func waitChatIdle(t *testing.T, c *Core, chatID string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := c.Invoke("chats.get", mustJSON(map[string]any{"id": chatID}))
		var g struct {
			Working bool `json:"working"`
		}
		json.Unmarshal(out, &g)
		if !g.Working {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the chat is still working")
}

func (p *fakeInlineProvider) Name() string { return "fake-foundation" }

func (p *fakeInlineProvider) ListModels(context.Context) ([]string, error) {
	return []string{"apple-on-device"}, nil
}

func (p *fakeInlineProvider) Chat(ctx context.Context, req llm.ChatRequest, onDelta llm.DeltaFunc) (*llm.ChatResponse, error) {
	return &llm.ChatResponse{Message: llm.Message{Role: llm.RoleAssistant, Text: "Title"}, StopReason: llm.StopEndTurn}, nil
}

func (p *fakeInlineProvider) ChatWithTools(ctx context.Context, req llm.ChatRequest, invoke llm.ToolInvoker, onDelta llm.DeltaFunc) ([]llm.Message, error) {
	p.f.mu.Lock()
	p.f.sys = req.System
	p.f.opts = p.opts
	p.f.tools = nil
	for _, t := range req.Tools {
		p.f.tools = append(p.f.tools, t.Name)
	}
	p.f.mu.Unlock()
	call := llm.ToolCall{ID: "t1", Name: "create_task", Args: json.RawMessage(`{"title":"Buy milk"}`)}
	res := invoke(ctx, call)
	onDelta("Added it.")
	return []llm.Message{
		{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{call}},
		{Role: llm.RoleTool, ToolResults: []llm.ToolResult{res}},
		{Role: llm.RoleAssistant, Text: "Added it."},
	}, nil
}

func TestAppleFoundationAgent(t *testing.T) {
	c, _ := newTestCore(t)

	// Without an on-device model host, the runtime can't be installed.
	if _, err := c.Invoke("agents.install", mustJSON(map[string]any{"runtime": "apple-foundation"})); err == nil {
		t.Fatal("install should fail on a device with no Apple Intelligence")
	}

	fm := &fakeFoundation{}
	c.SetFoundationModels(fm)
	out, err := c.Invoke("agents.install", mustJSON(map[string]any{"runtime": "apple-foundation", "name": "Apple Intelligence"}))
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	var agent struct {
		ID           string  `json:"id"`
		HostDeviceID *string `json:"hostDeviceId"`
		HostedHere   bool    `json:"hostedHere"`
		Online       bool    `json:"online"`
		BaseURL      string  `json:"baseUrl"`
	}
	json.Unmarshal(out, &agent)
	if agent.HostDeviceID == nil || !agent.HostedHere || !agent.Online || agent.BaseURL != "" {
		t.Fatalf("an on-device agent should be pinned to, and online on, this device: %s", out)
	}

	models, err := c.Invoke("agents.models", mustJSON(map[string]any{"agentId": agent.ID}))
	if err != nil || !strings.Contains(string(models), "apple-on-device") {
		t.Fatalf("models: %s %v", models, err)
	}

	chatOut, _ := c.Invoke("chats.create", mustJSON(map[string]any{}))
	var chat struct {
		ID string `json:"id"`
	}
	json.Unmarshal(chatOut, &chat)
	if _, err := c.Invoke("chats.send", mustJSON(map[string]any{"chatId": chat.ID, "text": "add a task to buy milk", "model": "apple-on-device"})); err != nil {
		t.Fatalf("send: %v", err)
	}

	var msgs []struct {
		Role      string            `json:"role"`
		Text      string            `json:"text"`
		ToolCalls []json.RawMessage `json:"toolCalls"`
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		got, _ := c.Invoke("chats.get", mustJSON(map[string]any{"id": chat.ID}))
		var g struct {
			Working  bool `json:"working"`
			Messages json.RawMessage
		}
		json.Unmarshal(got, &g)
		json.Unmarshal(g.Messages, &msgs)
		if !g.Working && len(msgs) > 0 && msgs[len(msgs)-1].Text == "Added it." {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(msgs) == 0 || msgs[len(msgs)-1].Text != "Added it." {
		t.Fatalf("reply not persisted: %+v", msgs)
	}

	tasks, _ := c.store.Tasks.List()
	if len(tasks) != 1 || tasks[0].Title != "Buy milk" {
		t.Errorf("the inline tool call should have created the task: %+v", tasks)
	}

	fm.mu.Lock()
	if fm.sys != foundationSystemPrompt {
		t.Error("the on-device model should get the short system prompt")
	}
	// By default it gets every tool, trimmed to fit.
	if !fm.opts.Short || len(fm.tools) <= len(foundationTools) {
		t.Errorf("default should offer every tool in short mode: short=%v tools=%d", fm.opts.Short, len(fm.tools))
	}
	fm.mu.Unlock()

	// toolMode "lean" offers the core tools only.
	if _, err := c.Invoke("agents.update", mustJSON(map[string]any{"id": agent.ID, "settingsJson": `{"toolMode":"lean"}`})); err != nil {
		t.Fatalf("update: %v", err)
	}
	if _, err := c.Invoke("chats.send", mustJSON(map[string]any{"chatId": chat.ID, "text": "and eggs", "model": "apple-on-device"})); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitChatIdle(t, c, chat.ID)
	fm.mu.Lock()
	defer fm.mu.Unlock()
	if fm.opts.Short || len(fm.tools) == 0 || len(fm.tools) > len(foundationTools) {
		t.Errorf("lean mode should offer only the core tools: short=%v %v", fm.opts.Short, fm.tools)
	}
}
