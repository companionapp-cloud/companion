package bridge

import (
	"encoding/json"
	"fmt"
	"time"

	"companion/core/domain"
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

	documents, err := c.store.Documents.ListTrash()
	if err != nil {
		return nil, err
	}
	for _, d := range documents {
		items = append(items, trashItem{
			EntityType: "document",
			ID:         d.ID,
			Title:      d.Filename,
			DeletingAt: d.DeletingAt,
			UpdatedAt:  d.UpdatedAt,
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
		// Restore re-derives the note's edges, so its embedded documents are readable again;
		// bring the files that rode it into the Trash back with it (PLAN §6.9).
		docIDs, err := c.store.Links.EmbeddedDocumentIDs(domain.NodeNote, id)
		if err != nil {
			return nil, err
		}
		if err := c.cascadeRestoreDocuments(docIDs); err != nil {
			return nil, err
		}
		c.emit(notesChangedEvent, nil)
		c.emitDataChanged("note", id)
	case "task":
		if err := c.store.Tasks.Restore(id); err != nil {
			return nil, mapStoreErr(err)
		}
		c.emitTaskChanged(id)
	case "document":
		if err := c.store.Documents.Restore(id); err != nil {
			return nil, mapStoreErr(err)
		}
		c.emitDocumentChanged(id)
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
	if err := c.purgeTrashItem(entityType, id); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]bool{"ok": true})
}

// trashEmpty permanently deletes every trashed entity now ("Empty trash"), tombstoning
// each so the deletes sync. It's a single bulk request: the rows are purged silently and
// one batch of change events is emitted after, instead of one per item (cf. notesDeleteMany).
func (c *Core) trashEmpty() ([]byte, error) {
	notes, err := c.store.Notes.ListTrash()
	if err != nil {
		return nil, err
	}
	for _, n := range notes {
		if err := c.deleteTrashItem("note", n.ID); err != nil {
			return nil, err
		}
	}

	tasks, err := c.store.Tasks.ListTrash()
	if err != nil {
		return nil, err
	}
	for _, t := range tasks {
		if err := c.deleteTrashItem("task", t.ID); err != nil {
			return nil, err
		}
	}

	documents, err := c.store.Documents.ListTrash()
	if err != nil {
		return nil, err
	}
	for _, d := range documents {
		if err := c.deleteTrashItem("document", d.ID); err != nil {
			return nil, err
		}
	}

	// One batch notification per affected surface, plus a single bulk data.changed.
	if len(notes) > 0 {
		c.emit(notesChangedEvent, nil)
	}
	if len(tasks) > 0 {
		c.emit(tasksChangedEvent, nil)
		c.emit(navChangedEvent, nil)
	}
	if len(documents) > 0 {
		c.emit(documentsChangedEvent, nil)
	}
	if len(notes)+len(tasks)+len(documents) > 0 {
		c.emitDataChanged("", "")
	}

	return json.Marshal(map[string]bool{"ok": true})
}

// purgeTrashItem tombstones one trashed entity and emits its change events, dispatching to
// the right repo by type. Used by "Delete forever" (trashPurge) for single-item deletes;
// "Empty trash" purges silently via deleteTrashItem and emits once for the whole batch.
func (c *Core) purgeTrashItem(entityType, id string) error {
	if err := c.deleteTrashItem(entityType, id); err != nil {
		return err
	}
	switch entityType {
	case "note":
		c.emit(notesChangedEvent, nil)
		c.emitDataChanged("note", id)
	case "task":
		c.emitTaskChanged(id)
	case "document":
		c.emitDocumentChanged(id)
	}
	return nil
}

// deleteTrashItem tombstones one trashed entity (GCing document blobs) without emitting any
// change events, so callers control notification granularity.
func (c *Core) deleteTrashItem(entityType, id string) error {
	switch entityType {
	case "note":
		if err := c.store.Notes.Delete(id); err != nil {
			return mapStoreErr(err)
		}
	case "task":
		if err := c.store.Tasks.Delete(id); err != nil {
			return mapStoreErr(err)
		}
	case "document":
		if err := c.purgeDocument(id); err != nil {
			return mapStoreErr(err)
		}
	default:
		return fmt.Errorf("cannot purge entity type %q", entityType)
	}
	return nil
}

// purgeDocument tombstones a document and GCs its local bytes when no other live document
// row still references the same content hash (PLAN §6.9). The hash is read before the
// tombstone so the reference check sees the pre-delete state; HashReferencedElsewhere
// already excludes this id, and the tombstone clears its own reference regardless.
func (c *Core) purgeDocument(id string) error {
	d, err := c.store.Documents.GetAny(id)
	if err != nil {
		return err
	}
	if err := c.store.Documents.Delete(id); err != nil {
		return err
	}
	if c.blobs == nil {
		return nil
	}
	referenced, err := c.store.Documents.HashReferencedElsewhere(d.SHA256, id)
	if err != nil {
		return err
	}
	if !referenced {
		// Best-effort: a failed local delete only leaves an orphaned blob, not corruption.
		_ = c.blobs.Delete(d.SHA256)
	}
	return nil
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
