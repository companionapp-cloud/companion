package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// ChatMessagesRepo is the CRUD + sync repository for chat messages (PLAN §6.8): ordered
// turns within a chat, appended as the conversation runs and synced as their own rows.
type ChatMessagesRepo struct {
	db    Driver
	clock domain.Clock
}

const chatMessageColumns = `id, chat_id, seq, role, text, tool_calls, tool_results, created_at, updated_at, deleted_at, version, dirty`

// Append adds a message to the end of a chat, assigning the next seq. toolCalls/toolResults
// are raw JSON arrays (nil when absent).
func (r *ChatMessagesRepo) Append(chatID, role, text string, toolCalls, toolResults json.RawMessage) (*domain.ChatMessage, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	seq, err := r.nextSeq(chatID)
	if err != nil {
		return nil, err
	}
	now := r.clock.Now().UTC()
	m := &domain.ChatMessage{
		ID: id.String(), ChatID: chatID, Seq: seq, Role: role, Text: text,
		ToolCalls: toolCalls, ToolResults: toolResults,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO chat_messages (id, chat_id, seq, role, text, tool_calls, tool_results, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		m.ID, m.ChatID, m.Seq, m.Role, m.Text, rawOrNil(m.ToolCalls), rawOrNil(m.ToolResults),
		m.CreatedAt.Format(timeFormat), m.UpdatedAt.Format(timeFormat), m.Version, boolToInt(m.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert chat message: %w", err)
	}
	return m, nil
}

// nextSeq returns the next ordering slot for a chat (0 when empty). Counts every row,
// tombstones included, so seq is monotonic and never reused.
func (r *ChatMessagesRepo) nextSeq(chatID string) (int64, error) {
	rows, err := r.db.Query(`SELECT COALESCE(MAX(seq), -1) + 1 FROM chat_messages WHERE chat_id = ?;`, chatID)
	if err != nil {
		return 0, fmt.Errorf("next seq: %w", err)
	}
	defer rows.Close()
	var next int64
	if rows.Next() {
		if err := rows.Scan(&next); err != nil {
			return 0, err
		}
	}
	return next, rows.Err()
}

// ListForChat returns a chat's live messages in order.
func (r *ChatMessagesRepo) ListForChat(chatID string) ([]*domain.ChatMessage, error) {
	rows, err := r.db.Query(
		`SELECT `+chatMessageColumns+` FROM chat_messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY seq ASC;`, chatID)
	if err != nil {
		return nil, fmt.Errorf("query chat messages: %w", err)
	}
	defer rows.Close()
	out := []*domain.ChatMessage{}
	for rows.Next() {
		m, err := scanChatMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// TombstoneForChat marks every live message of a chat deleted (called when the chat itself
// is deleted, so the messages sync-delete too).
func (r *ChatMessagesRepo) TombstoneForChat(chatID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE chat_messages SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE chat_id = ? AND deleted_at IS NULL;`,
		now, now, chatID,
	); err != nil {
		return fmt.Errorf("tombstone chat messages: %w", err)
	}
	return nil
}

// --- SyncableRepo[*domain.ChatMessage] ------------------------------------

func (r *ChatMessagesRepo) EntityType() string { return protocol.EntityChatMessage }

func (r *ChatMessagesRepo) Dirty() ([]*domain.ChatMessage, error) {
	rows, err := r.db.Query(`SELECT ` + chatMessageColumns + ` FROM chat_messages WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty chat messages: %w", err)
	}
	defer rows.Close()
	out := []*domain.ChatMessage{}
	for rows.Next() {
		m, err := scanChatMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (r *ChatMessagesRepo) GetAny(id string) (*domain.ChatMessage, error) {
	rows, err := r.db.Query(`SELECT `+chatMessageColumns+` FROM chat_messages WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query chat message: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanChatMessage(rows)
}

func (r *ChatMessagesRepo) Apply(m *domain.ChatMessage) error {
	var deletedAt any
	if m.DeletedAt != nil {
		deletedAt = m.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO chat_messages (id, chat_id, seq, role, text, tool_calls, tool_results, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   chat_id = excluded.chat_id, seq = excluded.seq, role = excluded.role, text = excluded.text,
		   tool_calls = excluded.tool_calls, tool_results = excluded.tool_results,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		m.ID, m.ChatID, m.Seq, m.Role, m.Text, rawOrNil(m.ToolCalls), rawOrNil(m.ToolResults),
		m.CreatedAt.UTC().Format(timeFormat), m.UpdatedAt.UTC().Format(timeFormat), deletedAt, m.Version,
	)
	if err != nil {
		return fmt.Errorf("apply chat message: %w", err)
	}
	return nil
}

func (r *ChatMessagesRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE chat_messages SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff: messages are effectively immutable once created; only alive-vs-deleted
// meaningfully differs (their content is written once and never edited).
func (r *ChatMessagesRepo) MeaningfulDiff(a, b *domain.ChatMessage) bool {
	if a.Text != b.Text || a.Role != b.Role || a.Seq != b.Seq {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *ChatMessagesRepo) Decode(raw json.RawMessage) (*domain.ChatMessage, error) {
	var m domain.ChatMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("decode chat message: %w", err)
	}
	return &m, nil
}

// ConflictedCopy is a no-op: messages are append-only and never concurrently edited, so a
// conflict has no local content to preserve (server wins).
func (r *ChatMessagesRepo) ConflictedCopy(_ *domain.ChatMessage, _ string) error { return nil }

func scanChatMessage(rows Rows) (*domain.ChatMessage, error) {
	var (
		m                      domain.ChatMessage
		toolCalls, toolResults sql.NullString
		deletedAt              sql.NullString
		createdAt, updatedAt   string
		dirty                  int
	)
	if err := rows.Scan(&m.ID, &m.ChatID, &m.Seq, &m.Role, &m.Text, &toolCalls, &toolResults,
		&createdAt, &updatedAt, &deletedAt, &m.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan chat message: %w", err)
	}
	if toolCalls.Valid {
		m.ToolCalls = json.RawMessage(toolCalls.String)
	}
	if toolResults.Valid {
		m.ToolResults = json.RawMessage(toolResults.String)
	}
	var err error
	if m.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if m.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		m.DeletedAt = &t
	}
	m.Dirty = dirty != 0
	return &m, nil
}

// rawOrNil converts a possibly-empty json.RawMessage to a nullable DB value.
func rawOrNil(r json.RawMessage) any {
	if len(r) == 0 {
		return nil
	}
	return string(r)
}
