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

// ChatsRepo is the CRUD + sync repository for chats (PLAN §6.8). Chats are tombstoned on
// delete (no Trash). ChatMessages are a sibling repo, ordered per chat by seq.
type ChatsRepo struct {
	db    Driver
	clock domain.Clock
}

const chatColumns = `id, title, config_id, created_at, updated_at, deleted_at, version, dirty`

// Create inserts a new chat (UUIDv7 id, version 0, dirty).
func (r *ChatsRepo) Create(title string, configID *string) (*domain.Chat, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	c := &domain.Chat{ID: id.String(), Title: title, ConfigID: configID, CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO chats (id, title, config_id, created_at, updated_at, version, dirty) VALUES (?, ?, ?, ?, ?, ?, ?);`,
		c.ID, c.Title, c.ConfigID, c.CreatedAt.Format(timeFormat), c.UpdatedAt.Format(timeFormat), c.Version, boolToInt(c.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert chat: %w", err)
	}
	return c, nil
}

// Get returns a live chat by id, or ErrNotFound.
func (r *ChatsRepo) Get(id string) (*domain.Chat, error) {
	rows, err := r.db.Query(`SELECT `+chatColumns+` FROM chats WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query chat: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanChat(rows)
}

// List returns all live chats, most-recently-updated first.
func (r *ChatsRepo) List() ([]*domain.Chat, error) {
	rows, err := r.db.Query(`SELECT ` + chatColumns + ` FROM chats WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC;`)
	if err != nil {
		return nil, fmt.Errorf("query chats: %w", err)
	}
	defer rows.Close()
	out := []*domain.Chat{}
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetTitle updates a chat's title (used to name a chat from its first message), bumping
// updated_at and marking it dirty.
func (r *ChatsRepo) SetTitle(id, title string) error {
	return r.patch(id, `title = ?`, title)
}

// Touch bumps updated_at (and dirty) so a chat sorts to the top after new activity.
func (r *ChatsRepo) Touch(id string) error {
	return r.patch(id, ``)
}

// SetConfig re-pins which provider config a chat runs on (nil = account default).
func (r *ChatsRepo) SetConfig(id string, configID *string) error {
	return r.patch(id, `config_id = ?`, configID)
}

// patch applies an optional `set` fragment plus updated_at/dirty to a live chat.
func (r *ChatsRepo) patch(id, set string, args ...any) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	q := `UPDATE chats SET updated_at = ?, dirty = 1`
	all := []any{now}
	if set != "" {
		q += `, ` + set
		all = append(all, args...)
	}
	q += ` WHERE id = ? AND deleted_at IS NULL;`
	all = append(all, id)
	res, err := r.db.Exec(q, all...)
	if err != nil {
		return fmt.Errorf("update chat: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Delete tombstones a chat, marking it dirty so the delete syncs.
func (r *ChatsRepo) Delete(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(`UPDATE chats SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`, now, now, id)
	if err != nil {
		return fmt.Errorf("delete chat: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- SyncableRepo[*domain.Chat] -------------------------------------------

func (r *ChatsRepo) EntityType() string { return protocol.EntityChat }

func (r *ChatsRepo) Dirty() ([]*domain.Chat, error) {
	rows, err := r.db.Query(`SELECT ` + chatColumns + ` FROM chats WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty chats: %w", err)
	}
	defer rows.Close()
	out := []*domain.Chat{}
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (r *ChatsRepo) GetAny(id string) (*domain.Chat, error) {
	rows, err := r.db.Query(`SELECT `+chatColumns+` FROM chats WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query chat: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanChat(rows)
}

func (r *ChatsRepo) Apply(c *domain.Chat) error {
	var deletedAt any
	if c.DeletedAt != nil {
		deletedAt = c.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO chats (id, title, config_id, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   title = excluded.title, config_id = excluded.config_id,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		c.ID, c.Title, c.ConfigID, c.CreatedAt.UTC().Format(timeFormat), c.UpdatedAt.UTC().Format(timeFormat), deletedAt, c.Version,
	)
	if err != nil {
		return fmt.Errorf("apply chat: %w", err)
	}
	return nil
}

func (r *ChatsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE chats SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

func (r *ChatsRepo) MeaningfulDiff(a, b *domain.Chat) bool {
	if a.Title != b.Title || derefStr(a.ConfigID) != derefStr(b.ConfigID) {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *ChatsRepo) Decode(raw json.RawMessage) (*domain.Chat, error) {
	var c domain.Chat
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("decode chat: %w", err)
	}
	return &c, nil
}

// ConflictedCopy forks a losing local chat so a local rename/config change isn't lost.
func (r *ChatsRepo) ConflictedCopy(local *domain.Chat, suffix string) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC().Format(timeFormat)
	title := local.Title
	if title == "" {
		title = "Chat"
	}
	_, err = r.db.Exec(
		`INSERT INTO chats (id, title, config_id, created_at, updated_at, version, dirty) VALUES (?, ?, ?, ?, ?, 0, 1);`,
		id.String(), title+" "+suffix, local.ConfigID, now, now,
	)
	if err != nil {
		return fmt.Errorf("insert conflicted chat: %w", err)
	}
	return nil
}

func scanChat(rows Rows) (*domain.Chat, error) {
	var (
		c                    domain.Chat
		configID, deletedAt  sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&c.ID, &c.Title, &configID, &createdAt, &updatedAt, &deletedAt, &c.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan chat: %w", err)
	}
	if configID.Valid {
		c.ConfigID = &configID.String
	}
	var err error
	if c.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if c.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		c.DeletedAt = &t
	}
	c.Dirty = dirty != 0
	return &c, nil
}
