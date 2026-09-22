package bridge

import (
	"encoding/json"
	"errors"

	"companion/core/store"
)

// Settings › Danger Zone: count what each kind of data holds, and clear it. A clear is
// permanent and skips the Trash; the rows become tombstones that sync, so on a signed-in
// device the data leaves every device and the server (store/cleardata.go).

// dataSummary counts the live rows behind each Danger Zone row.
func (c *Core) dataSummary() ([]byte, error) {
	sum, err := c.store.DataSummary()
	if err != nil {
		return nil, err
	}
	return json.Marshal(sum)
}

// dataClear permanently deletes the given kinds of data, or everything with "all". It stops
// what would write into the data first (a chat that is still answering), clears the rows in
// one transaction, then removes what lives outside the database: device secrets, Git export
// working copies, and the bytes of files nothing uses anymore. Once the rows are gone every
// screen is told to reload, and a sync is requested so the deletion reaches the server now.
func (c *Core) dataClear(payload []byte) ([]byte, error) {
	var args struct {
		Kinds []store.DataKind `json:"kinds"`
		All   bool             `json:"all"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	kinds := args.Kinds
	if args.All {
		kinds = store.AllDataKinds
	}
	if len(kinds) == 0 {
		return nil, errors.New("nothing to clear")
	}
	want := map[store.DataKind]bool{}
	for _, k := range kinds {
		if !store.ValidDataKind(k) {
			return nil, errors.New("unknown data kind: " + string(k))
		}
		want[k] = true
	}

	// A chat still answering would append messages to a conversation that is being deleted.
	if want[store.DataChats] {
		c.chatMu.Lock()
		running := make([]string, 0, len(c.working))
		for id := range c.working {
			running = append(running, id)
		}
		c.chatMu.Unlock()
		for _, id := range running {
			c.cancelChat(id)
		}
	}

	rep, err := c.store.ClearData(kinds)
	if err != nil {
		return nil, err
	}

	// Best effort: a leftover secret, repository or blob is garbage, never a leak of what the
	// rows held, and the rows themselves are already gone.
	if c.secrets != nil {
		for _, ref := range rep.SecretRefs {
			_ = c.secrets.DeleteSecret(ref)
		}
	}
	for _, id := range rep.GitExports {
		c.removeExportRepo(id)
	}
	if c.blobs != nil {
		for _, sha := range rep.OrphanBlobs {
			_ = c.blobs.Delete(sha)
		}
	}

	c.emitCleared(want)
	c.requestSync()
	return json.Marshal(map[string]any{"cleared": rep.Cleared})
}

// emitCleared tells every surface that shows a cleared kind to reload, once per surface.
func (c *Core) emitCleared(want map[store.DataKind]bool) {
	if want[store.DataNotes] {
		c.emit(notesChangedEvent, nil)
	}
	if want[store.DataTasks] {
		c.emit(tasksChangedEvent, nil)
		c.emit(notificationsChangedEvent, nil)
	}
	if want[store.DataCanvases] {
		c.emit(canvasesChangedEvent, nil)
	}
	if want[store.DataCalendar] {
		c.emit(calendarChangedEvent, nil)
	}
	if want[store.DataTasks] || want[store.DataAreas] || want[store.DataCalendar] {
		// Lists hold tasks, and the sidebar counts what projects hold.
		c.emit(listsChangedEvent, nil)
		c.emit(navChangedEvent, nil)
	}
	// Notes and canvases take the files only they used with them.
	if want[store.DataFiles] || want[store.DataNotes] || want[store.DataTasks] || want[store.DataCanvases] || want[store.DataAreas] {
		c.emit(documentsChangedEvent, nil)
	}
	if want[store.DataObjectTypes] {
		c.emit(objectTypesChangedEvent, nil)
	}
	if want[store.DataAgents] {
		c.emitAgentsChanged()
	}
	if want[store.DataExports] {
		c.emitExportChanged("")
	}
	// Chats, the graph, and everything else that listens for a bulk change.
	c.emitDataChanged("", "")
}
