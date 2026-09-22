package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"companion/core/agents"
	"companion/core/domain"
	"companion/core/llm"
)

// Chat bridge methods (PLAN §6.8, PLAN-agents.md §2.3). A chat is a persisted, synced
// conversation; sending a message runs the agent on a background goroutine so the answer keeps
// generating — and is saved — even if the user navigates away. Streaming text and tool actions
// go out as events tagged with the chat id; list/detail screens re-read the store on
// chat.changed.
//
// Routing: an HTTP agent (cloud API, Ollama, LM Studio) runs the built-in agentic loop here; a
// CLI agent hosted by this device runs as a child process; an agent hosted by another device
// is driven through the relay, and its host persists the transcript.

const (
	eventChatChanged = "chat.changed" // a chat's messages or title changed; reload it
	eventChatWorking = "chat.working" // a chat's run started/finished; update spinners
)

// chatTitleMax bounds an auto-generated chat title (from the first user message).
const chatTitleMax = 60

// chatSummary is a chat plus its runtime "working" flag for list rendering.
type chatSummary struct {
	*domain.Chat
	Working bool `json:"working"`
}

func (c *Core) chatsList() ([]byte, error) {
	chats, err := c.store.Chats.List()
	if err != nil {
		return nil, err
	}
	out := make([]chatSummary, 0, len(chats))
	for _, ch := range chats {
		out = append(out, chatSummary{Chat: ch, Working: c.isWorking(ch.ID)})
	}
	return json.Marshal(out)
}

func (c *Core) chatsGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	chat, err := c.store.Chats.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	msgs, err := c.store.ChatMessages.ListForChat(args.ID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{
		"chat":     chat,
		"messages": msgs,
		"working":  c.isWorking(args.ID),
	})
}

func (c *Core) chatsCreate(payload []byte) ([]byte, error) {
	var args struct {
		Title    string  `json:"title"`
		AgentID  *string `json:"agentId"`
		ConfigID *string `json:"configId"` // legacy alias
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.AgentID == nil {
		args.AgentID = args.ConfigID
	}
	chat, err := c.store.Chats.Create(args.Title, args.AgentID)
	if err != nil {
		return nil, err
	}
	c.emitChatChanged(chat.ID)
	return json.Marshal(chat)
}

func (c *Core) chatsRename(payload []byte) ([]byte, error) {
	var args struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Chats.SetTitle(args.ID, args.Title); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitChatChanged(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) chatsDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	c.cancelChat(args.ID)
	if err := c.store.Chats.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	if err := c.store.ChatMessages.TombstoneForChat(args.ID); err != nil {
		return nil, err
	}
	c.emitDataChanged("", "")
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) chatsWorking() ([]byte, error) {
	c.chatMu.Lock()
	defer c.chatMu.Unlock()
	ids := make([]string, 0, len(c.working))
	for id := range c.working {
		ids = append(ids, id)
	}
	return json.Marshal(ids)
}

// chatsCancel aborts a chat's in-flight run (kills a CLI child, closes an HTTP stream). Whatever
// the run had already produced is not persisted; the user turn stays.
func (c *Core) chatsCancel(payload []byte) ([]byte, error) {
	var args struct {
		ChatID string `json:"chatId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	cancelled := c.cancelChat(args.ChatID)
	if !cancelled && c.relay != nil {
		cancelled = c.relay.cancelRemote(args.ChatID)
	}
	return json.Marshal(map[string]bool{"ok": true, "cancelled": cancelled})
}

// chatsSend appends the user's message to a chat and launches the agent run in the
// background, returning immediately. Streaming text/tool events and, on completion, the
// persisted reply reach the UI via events.
func (c *Core) chatsSend(payload []byte) ([]byte, error) {
	var args struct {
		ChatID   string  `json:"chatId"`
		Text     string  `json:"text"`
		AgentID  *string `json:"agentId"`
		ConfigID *string `json:"configId"` // legacy alias
		Model    *string `json:"model"`
		// Resume means the user turn is already persisted (it arrived via sync from the device
		// that typed it) and only the assistant run is wanted. Set by the relay host path only.
		Resume bool `json:"resume"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.AgentID == nil {
		args.AgentID = args.ConfigID
	}
	if strings.TrimSpace(args.Text) == "" && !args.Resume {
		return nil, errors.New("empty message")
	}
	chat, err := c.store.Chats.Get(args.ChatID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if c.isWorking(chat.ID) {
		return nil, errors.New("this chat is already generating a reply")
	}
	// Re-pin the chat's agent if the composer picked a different one. Switching agents also
	// drops any CLI session, since it belongs to the previous tool.
	if args.AgentID != nil && chatDerefStr(args.AgentID) != chatDerefStr(chat.ConfigID) {
		_ = c.store.Chats.SetConfig(chat.ID, args.AgentID)
		chat.ConfigID = args.AgentID
		if chat.AgentSessionID != nil {
			_ = c.store.Chats.SetAgentSession(chat.ID, nil)
			chat.AgentSessionID = nil
		}
	}
	// Re-pin the chat's model if the composer picked a different one.
	if args.Model != nil && chatDerefStr(args.Model) != chatDerefStr(chat.Model) {
		_ = c.store.Chats.SetModel(chat.ID, args.Model)
		chat.Model = args.Model
	}

	agent, err := c.resolveAgent(chatDerefStr(chat.ConfigID))
	if err != nil {
		return nil, err
	}
	me, _ := c.store.EnsureDeviceID()
	remote := agent.IsLocal() && !agent.IsHostedBy(me)

	// Persist the user turn and (for a fresh chat) name it from that first message.
	if !args.Resume {
		if _, err := c.store.ChatMessages.Append(chat.ID, domain.ChatRoleUser, args.Text, nil, nil); err != nil {
			return nil, err
		}
		if strings.TrimSpace(chat.Title) == "" {
			_ = c.store.Chats.SetTitle(chat.ID, truncateTitle(args.Text))
		} else {
			_ = c.store.Chats.Touch(chat.ID)
		}
		c.emitChatChanged(chat.ID)
	}

	if remote {
		return c.sendRemote(chat, agent, args.Text)
	}
	if args.Resume && args.Text == "" {
		// Recover the prompt for CLI runtimes from the last persisted user turn.
		if msgs, err := c.store.ChatMessages.ListForChat(chat.ID); err == nil {
			for i := len(msgs) - 1; i >= 0; i-- {
				if msgs[i].Role == domain.ChatRoleUser {
					args.Text = msgs[i].Text
					break
				}
			}
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	switch {
	case agent.Runtime.IsCLI():
		runner, err := c.runnerFor(agent)
		if err != nil {
			cancel()
			c.emitLLMError(chat.ID, err)
			return nil, err
		}
		cwd, err := c.runners.WorkDir(agent.ID)
		if err != nil {
			cancel()
			return nil, err
		}
		// The turns before this one, for when there is no CLI session to carry them (a fresh
		// agent on an existing chat, or a session the CLI has since dropped).
		msgs, err := c.store.ChatMessages.ListForChat(chat.ID)
		if err != nil {
			cancel()
			return nil, err
		}
		history := historyBeforeLastUser(msgs)
		prompt := args.Text
		if chat.AgentSessionID == nil {
			prompt = withCompactedHistory(history, prompt)
		}
		req := agents.RunRequest{
			Prompt:     prompt,
			Model:      chatDerefStr(chat.Model),
			SessionID:  chatDerefStr(chat.AgentSessionID),
			AllowSystem: agent.AllowSystem,
			Cwd:        cwd,
			MCP:        c.mcpEndpointFor(agent),
		}
		c.setWorking(chat.ID, cancel)
		go c.runCLIChat(ctx, chat.ID, runner, req, withCompactedHistory(history, args.Text))
	default:
		engine, err := c.buildEngine(agent, chatDerefStr(chat.Model))
		if err != nil {
			cancel()
			c.emitLLMError(chat.ID, err)
			return nil, err
		}
		// Snapshot the transcript and hand the run to a goroutine so Invoke returns now.
		msgs, err := c.store.ChatMessages.ListForChat(chat.ID)
		if err != nil {
			cancel()
			return nil, err
		}
		c.setWorking(chat.ID, cancel)
		go c.runChat(ctx, chat.ID, engine, toLLMMessages(msgs))
	}

	return json.Marshal(map[string]any{"ok": true, "working": true})
}

// runChat drives one assistant turn of the built-in engine to completion off the request path,
// streaming events and persisting every new message so the reply survives navigating away.
func (c *Core) runChat(ctx context.Context, chatID string, engine *llm.Engine, history []llm.Message) {
	defer c.finishRun(chatID)

	onDelta := func(text string) {
		p, _ := json.Marshal(map[string]string{"chatId": chatID, "text": text})
		c.emit(eventLLMToken, p)
	}
	onTool := func(ev llm.ToolEvent) {
		p, _ := json.Marshal(map[string]any{"chatId": chatID, "call": ev.Call, "result": ev.Result})
		c.emit(eventLLMTool, p)
	}

	inputLen := len(history)
	result, err := engine.Run(ctx, history, onDelta, onTool)
	if err != nil {
		if ctx.Err() == nil {
			c.emitLLMError(chatID, err)
		}
		return
	}
	// Persist the messages the run appended (assistant replies + tool-result turns).
	for _, m := range result[inputLen:] {
		if _, err := c.store.ChatMessages.Append(chatID, m.Role, m.Text, marshalRaw(m.ToolCalls), marshalRaw(m.ToolResults)); err != nil {
			c.emitLLMError(chatID, err)
			return
		}
	}
	_ = c.store.Chats.Touch(chatID)
}

// runCLIChat drives one turn of a CLI agent (Claude Code, Codex). The CLI owns the
// conversation state; we stream its text and tool uses as the same events the built-in engine
// emits, then persist the final reply (with the tools it used, as an assistant tool_calls list)
// and remember the CLI session so the next turn resumes it. If the session it resumes has
// expired, the turn is retried once in a fresh session with compactedPrompt (the earlier
// transcript, compacted, ahead of the user's message).
func (c *Core) runCLIChat(ctx context.Context, chatID string, runner agents.Runner, req agents.RunRequest, compactedPrompt string) {
	defer c.finishRun(chatID)

	onDelta := func(text string) {
		p, _ := json.Marshal(map[string]string{"chatId": chatID, "text": text})
		c.emit(eventLLMToken, p)
	}
	var used []llm.ToolCall
	onTool := func(tu agents.ToolUse) {
		call := llm.ToolCall{ID: "", Name: tu.Name, Args: json.RawMessage(quoteJSON(tu.Input))}
		used = append(used, call)
		p, _ := json.Marshal(map[string]any{
			"chatId": chatID,
			"call":   call,
			"result": llm.ToolResult{Content: tu.Output},
		})
		c.emit(eventLLMTool, p)
	}

	res, err := runner.Run(ctx, req, onDelta, onTool)
	if err != nil && errors.Is(err, agents.ErrSessionExpired) && ctx.Err() == nil {
		_ = c.store.Chats.SetAgentSession(chatID, nil)
		req.SessionID = ""
		req.Prompt = compactedPrompt
		used = nil
		res, err = runner.Run(ctx, req, onDelta, onTool)
	}
	if err != nil {
		if ctx.Err() == nil {
			c.emitLLMError(chatID, err)
		}
		return
	}
	if res.SessionID != "" && res.SessionID != req.SessionID {
		_ = c.store.Chats.SetAgentSession(chatID, &res.SessionID)
	}
	if _, err := c.store.ChatMessages.Append(chatID, domain.ChatRoleAssistant, res.Text, marshalRaw(used), nil); err != nil {
		c.emitLLMError(chatID, err)
		return
	}
	_ = c.store.Chats.Touch(chatID)
}

// finishRun clears the working flag and pokes the UI to reload the persisted transcript.
func (c *Core) finishRun(chatID string) {
	c.clearWorking(chatID)
	c.emitChatChanged(chatID)
	c.emitDataChanged("", "")
}

// quoteJSON wraps a plain string as a JSON value (a CLI tool's input is opaque text, not our
// tool-args object), so it round-trips through the ToolCall.Args json.RawMessage.
func quoteJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// --- working set ----------------------------------------------------------

func (c *Core) setWorking(chatID string, cancel context.CancelFunc) {
	c.chatMu.Lock()
	c.working[chatID] = cancel
	c.chatMu.Unlock()
	c.emitWorking(chatID, true)
}

func (c *Core) clearWorking(chatID string) {
	c.chatMu.Lock()
	delete(c.working, chatID)
	c.chatMu.Unlock()
	c.emitWorking(chatID, false)
}

// cancelChat aborts a live local run; reports whether there was one.
func (c *Core) cancelChat(chatID string) bool {
	c.chatMu.Lock()
	cancel, ok := c.working[chatID]
	c.chatMu.Unlock()
	if ok && cancel != nil {
		cancel()
	}
	return ok
}

func (c *Core) emitWorking(chatID string, working bool) {
	p, _ := json.Marshal(map[string]any{"chatId": chatID, "working": working})
	c.emit(eventChatWorking, p)
}

func (c *Core) isWorking(chatID string) bool {
	c.chatMu.Lock()
	defer c.chatMu.Unlock()
	_, ok := c.working[chatID]
	return ok
}

func (c *Core) emitChatChanged(chatID string) {
	p, _ := json.Marshal(map[string]string{"chatId": chatID})
	c.emit(eventChatChanged, p)
}

// --- conversions ----------------------------------------------------------

// toLLMMessages converts stored chat messages into the neutral transcript the engine runs
// on, decoding the tool-call/result JSON back into typed values.
func toLLMMessages(msgs []*domain.ChatMessage) []llm.Message {
	out := make([]llm.Message, 0, len(msgs))
	for _, m := range msgs {
		lm := llm.Message{Role: m.Role, Text: m.Text}
		if len(m.ToolCalls) > 0 {
			_ = json.Unmarshal(m.ToolCalls, &lm.ToolCalls)
		}
		if len(m.ToolResults) > 0 {
			_ = json.Unmarshal(m.ToolResults, &lm.ToolResults)
		}
		out = append(out, lm)
	}
	return out
}

// marshalRaw serializes a tool-call/result slice for storage, returning nil when empty so
// the DB column stays NULL.
func marshalRaw[T any](v []T) json.RawMessage {
	if len(v) == 0 {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func truncateTitle(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) <= chatTitleMax {
		return s
	}
	return strings.TrimSpace(s[:chatTitleMax]) + "…"
}

// chatDerefStr returns the pointed-to string, or "" for nil (chat agent id → default agent).
func chatDerefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
