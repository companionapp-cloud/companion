package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Chat roles, matching the neutral llm transcript.
const (
	ChatRoleUser      = "user"
	ChatRoleAssistant = "assistant"
	ChatRoleTool      = "tool"
)

// Chat is one saved conversation with the assistant (PLAN §6.8). It syncs across the user's
// devices so a conversation started on one continues on another; its messages live in
// separate ChatMessage rows. A chat pins the provider config it runs on (ConfigID; nil means
// "the account default at run time") and the model chosen for it (Model; nil until the user
// picks one from the provider's live model list).
type Chat struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	ConfigID  *string    `json:"configId,omitempty"`
	Model     *string    `json:"model,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// ErrInvalidChat is returned when a chat fails validation.
var ErrInvalidChat = errors.New("invalid chat")

// Validate checks the invariants that must hold before a chat is persisted.
func (c *Chat) Validate() error {
	if strings.TrimSpace(c.ID) == "" {
		return errors.Join(ErrInvalidChat, errors.New("id is required"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (c *Chat) SyncID() string           { return c.ID }
func (c *Chat) SyncVersion() int64       { return c.Version }
func (c *Chat) SyncUpdatedAt() time.Time { return c.UpdatedAt }
func (c *Chat) SyncDeleted() bool        { return c.DeletedAt != nil }
func (c *Chat) SyncDirty() bool          { return c.Dirty }

// ChatMessage is one turn in a Chat (PLAN §6.8): a user prompt, an assistant reply (with any
// tool calls it made), or a tool-result turn. Messages are ordered within a chat by Seq and
// sync as their own rows. ToolCalls/ToolResults are raw JSON arrays of the neutral llm
// shapes (null when absent), so the exact transcript replays on any device.
type ChatMessage struct {
	ID          string          `json:"id"`
	ChatID      string          `json:"chatId"`
	Seq         int64           `json:"seq"`
	Role        string          `json:"role"`
	Text        string          `json:"text"`
	ToolCalls   json.RawMessage `json:"toolCalls,omitempty"`
	ToolResults json.RawMessage `json:"toolResults,omitempty"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
	DeletedAt   *time.Time      `json:"deletedAt,omitempty"`
	Version     int64           `json:"version"`
	Dirty       bool            `json:"dirty"`
}

// Validate checks the invariants that must hold before a chat message is persisted.
func (m *ChatMessage) Validate() error {
	if strings.TrimSpace(m.ID) == "" {
		return errors.Join(ErrInvalidChat, errors.New("message id is required"))
	}
	if strings.TrimSpace(m.ChatID) == "" {
		return errors.Join(ErrInvalidChat, errors.New("message chatId is required"))
	}
	if m.Role != ChatRoleUser && m.Role != ChatRoleAssistant && m.Role != ChatRoleTool {
		return errors.Join(ErrInvalidChat, errors.New("unknown message role"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (m *ChatMessage) SyncID() string           { return m.ID }
func (m *ChatMessage) SyncVersion() int64       { return m.Version }
func (m *ChatMessage) SyncUpdatedAt() time.Time { return m.UpdatedAt }
func (m *ChatMessage) SyncDeleted() bool        { return m.DeletedAt != nil }
func (m *ChatMessage) SyncDirty() bool          { return m.Dirty }
