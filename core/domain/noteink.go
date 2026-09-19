package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Note ink (PLAN-drawing.md): freehand drawing over a note, including over its text. A
// note's ink is a set of ink groups (strokes drawn close together in time and space), each
// its own synced row keyed by the note. Two devices drawing on one note therefore merge per
// group rather than forking the note, and the note's markdown never carries stroke data.
//
// The core treats a group's Data as opaque: the editor owns the stroke encoding and the
// text anchor that pins the group to the words under it. Data is encrypted whole on the
// wire because both parts are the user's content: the strokes are their handwriting and the
// anchor quotes the note's text.

// MaxNoteInkData caps one group's payload so a runaway drawing can't bloat sync. The editor
// starts a new group well before a group grows this large.
const MaxNoteInkData = 128 * 1024

// NoteInk is one ink group on a note.
type NoteInk struct {
	ID        string          `json:"id"`
	NoteID    string          `json:"noteId"`
	Data      json.RawMessage `json:"data,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
	DeletedAt *time.Time      `json:"deletedAt,omitempty"`
	Version   int64           `json:"version"`
	Dirty     bool            `json:"dirty"`
}

// ErrInvalidNoteInk is returned when an ink group fails validation.
var ErrInvalidNoteInk = errors.New("invalid note ink")

// Validate checks a group's invariants: a UUID id (the editor picks it), a parent note, and a
// JSON-object payload within the size cap.
func (i *NoteInk) Validate() error {
	if _, err := uuid.Parse(strings.TrimSpace(i.ID)); err != nil {
		return errors.Join(ErrInvalidNoteInk, errors.New("id must be a UUID"))
	}
	if strings.TrimSpace(i.NoteID) == "" {
		return errors.Join(ErrInvalidNoteInk, errors.New("noteId is required"))
	}
	if len(i.Data) > MaxNoteInkData {
		return errors.Join(ErrInvalidNoteInk, errors.New("ink data too large"))
	}
	if len(i.Data) > 0 && string(i.Data) != "null" {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(i.Data, &obj); err != nil {
			return errors.Join(ErrInvalidNoteInk, errors.New("ink data must be a JSON object"))
		}
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (i *NoteInk) SyncID() string           { return i.ID }
func (i *NoteInk) SyncVersion() int64       { return i.Version }
func (i *NoteInk) SyncUpdatedAt() time.Time { return i.UpdatedAt }
func (i *NoteInk) SyncDeleted() bool        { return i.DeletedAt != nil }
func (i *NoteInk) SyncDirty() bool          { return i.Dirty }
