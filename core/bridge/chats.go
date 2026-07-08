package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"companion/core/domain"
	"companion/core/llm"
)

// Chat bridge methods (PLAN §6.8). A chat is a persisted, synced conversation; sending a
// message runs the agentic loop on a background goroutine so the answer keeps generating —
// and is saved — even if the user navigates away. Streaming text and tool actions go out as
// events tagged with the chat id; list/detail screens re-read the store on chat.changed.

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
		ConfigID *string `json:"configId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	chat, err := c.store.Chats.Create(args.Title, args.ConfigID)
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

// chatsSend appends the user's message to a chat and launches the assistant run in the
// background, returning immediately. Streaming text/tool events and, on completion, the
// persisted reply reach the UI via events.
func (c *Core) chatsSend(payload []byte) ([]byte, error) {
	var args struct {
		ChatID   string  `json:"chatId"`
		Text     string  `json:"text"`
		ConfigID *string `json:"configId"`
		Model    *string `json:"model"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Text) == "" {
		return nil, errors.New("empty message")
	}
	chat, err := c.store.Chats.Get(args.ChatID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if c.isWorking(chat.ID) {
		return nil, errors.New("this chat is already generating a reply")
	}
	// Re-pin the chat's provider if the composer picked a different one.
	if args.ConfigID != nil && chatDerefStr(args.ConfigID) != chatDerefStr(chat.ConfigID) {
		_ = c.store.Chats.SetConfig(chat.ID, args.ConfigID)
		chat.ConfigID = args.ConfigID
	}
	// Re-pin the chat's model if the composer picked a different one.
	if args.Model != nil && chatDerefStr(args.Model) != chatDerefStr(chat.Model) {
		_ = c.store.Chats.SetModel(chat.ID, args.Model)
		chat.Model = args.Model
	}

	// Persist the user turn and (for a fresh chat) name it from that first message.
	if _, err := c.store.ChatMessages.Append(chat.ID, domain.ChatRoleUser, args.Text, nil, nil); err != nil {
		return nil, err
	}
	if strings.TrimSpace(chat.Title) == "" {
		_ = c.store.Chats.SetTitle(chat.ID, truncateTitle(args.Text))
	} else {
		_ = c.store.Chats.Touch(chat.ID)
	}
	c.emitChatChanged(chat.ID)

	engine, err := c.buildEngine(chatDerefStr(chat.ConfigID), chatDerefStr(chat.Model))
	if err != nil {
		c.emitLLMError(chat.ID, err)
		return nil, err
	}

	// Snapshot the transcript and hand the run to a goroutine so Invoke returns now.
	msgs, err := c.store.ChatMessages.ListForChat(chat.ID)
	if err != nil {
		return nil, err
	}
	history := toLLMMessages(msgs)

	c.setWorking(chat.ID, true)
	go c.runChat(chat.ID, engine, history)

	return json.Marshal(map[string]any{"ok": true, "working": true})
}

// runChat drives one assistant turn to completion off the request path, streaming events and
// persisting every new message so the reply survives navigating away or closing the screen.
func (c *Core) runChat(chatID string, engine *llm.Engine, history []llm.Message) {
	defer func() {
		c.setWorking(chatID, false)
		c.emitChatChanged(chatID)
		c.emitDataChanged("", "")
	}()

	onDelta := func(text string) {
		p, _ := json.Marshal(map[string]string{"chatId": chatID, "text": text})
		c.emit(eventLLMToken, p)
	}
	onTool := func(ev llm.ToolEvent) {
		p, _ := json.Marshal(map[string]any{"chatId": chatID, "call": ev.Call, "result": ev.Result})
		c.emit(eventLLMTool, p)
	}

	inputLen := len(history)
	result, err := engine.Run(context.Background(), history, onDelta, onTool)
	if err != nil {
		c.emitLLMError(chatID, err)
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

// --- working set ----------------------------------------------------------

func (c *Core) setWorking(chatID string, working bool) {
	c.chatMu.Lock()
	if working {
		c.working[chatID] = true
	} else {
		delete(c.working, chatID)
	}
	c.chatMu.Unlock()
	p, _ := json.Marshal(map[string]any{"chatId": chatID, "working": working})
	c.emit(eventChatWorking, p)
}

func (c *Core) isWorking(chatID string) bool {
	c.chatMu.Lock()
	defer c.chatMu.Unlock()
	return c.working[chatID]
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

// derefStr returns the pointed-to string, or "" for nil (chat config id → default provider).
func chatDerefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
