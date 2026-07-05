package bridge

import (
	"encoding/json"
	"fmt"
	"time"
)

// The Trash surface (PLAN §4.3). It aggregates every trashable entity type behind one
// list/restore/purge API so a single client screen can show notes, tasks, and habits
// together. Notes are wired today; tasks and habits slot in here as they gain repos.

// trashItem is one entry in the Trash list — just enough for the UI to render a row and
// act on it, tagged by entity type so restore/purge can dispatch to the right repo.
type trashItem struct {
	EntityType string     `json:"entityType"`
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	DeletingAt *time.Time `json:"deletingAt,omitempty"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// trashList returns every trashed entity, soonest-to-be-purged first within each type.
func (c *Core) trashList() ([]byte, error) {
	items := []trashItem{}

	notes, err := c.store.Notes.ListTrash()
	if err != nil {
		return nil, err
	}
	for _, n := range notes {
		items = append(items, trashItem{
			EntityType: "note",
			ID:         n.ID,
			Title:      n.Title,
			DeletingAt: n.DeletingAt,
			UpdatedAt:  n.UpdatedAt,
		})
	}

	tasks, err := c.store.Tasks.ListTrash()
	if err != nil {
		return nil, err
	}
	for _, t := range tasks {
		items = append(items, trashItem{
			EntityType: "task",
			ID:         t.ID,
			Title:      t.Title,
			DeletingAt: t.DeletingAt,
			UpdatedAt:  t.UpdatedAt,
		})
	}

	// habits join here once they have repos + Trash support.

	return json.Marshal(items)
}

// trashRestore pulls a trashed entity back out of the Trash.
func (c *Core) trashRestore(payload []byte) ([]byte, error) {
	entityType, id, err := decodeTrashRef(payload)
	if err != nil {
		return nil, err
	}
	switch entityType {
	case "note":
		if err := c.store.Notes.Restore(id); err != nil {
			return nil, mapStoreErr(err)
		}
		c.emit(notesChangedEvent, nil)
		c.emitDataChanged("note", id)
	case "task":
		if err := c.store.Tasks.Restore(id); err != nil {
			return nil, mapStoreErr(err)
		}
		c.emitTaskChanged(id)
	default:
		return nil, fmt.Errorf("cannot restore entity type %q", entityType)
	}
	return json.Marshal(map[string]bool{"ok": true})
}

// trashPurge permanently deletes a trashed entity now (the "Delete forever" action),
// tombstoning it so the delete syncs.
func (c *Core) trashPurge(payload []byte) ([]byte, error) {
	entityType, id, err := decodeTrashRef(payload)
	if err != nil {
		return nil, err
	}
	switch entityType {
	case "note":
		if err := c.store.Notes.Delete(id); err != nil {
			return nil, mapStoreErr(err)
		}
		c.emit(notesChangedEvent, nil)
		c.emitDataChanged("note", id)
	case "task":
		if err := c.store.Tasks.Delete(id); err != nil {
			return nil, mapStoreErr(err)
		}
		c.emitTaskChanged(id)
	default:
		return nil, fmt.Errorf("cannot purge entity type %q", entityType)
	}
	return json.Marshal(map[string]bool{"ok": true})
}

func decodeTrashRef(payload []byte) (entityType, id string, err error) {
	var args struct {
		EntityType string `json:"entityType"`
		ID         string `json:"id"`
	}
	if err = unmarshal(payload, &args); err != nil {
		return "", "", err
	}
	return args.EntityType, args.ID, nil
}
