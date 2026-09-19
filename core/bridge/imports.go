package bridge

import (
	"context"
	"encoding/json"
	"errors"

	"companion/core/importer/things"
)

// Imports (PLAN §6.12). import.thingsScan reads a Things library and outlines it — the Inbox,
// each area with its projects — for the user to choose from; import.thingsRun imports the
// choice, streaming import.progress; import.cancel stops a run between batches. One import
// runs at a time.

// importProgressEvent carries {source, stage, done, total} while a run writes.
const importProgressEvent = "import.progress"

// SetImportFiles registers how core reads files the user picked, by handle — the web shell
// stages uploads and core takes their bytes from it. Native shells pass a path instead.
func (c *Core) SetImportFiles(read func(handle string) ([]byte, error)) { c.importFiles = read }

// importSource is where a library comes from on the wire: a path on this device (desktop,
// mobile), or files the web shell staged, by handle.
type importSource struct {
	Path  string `json:"path"`
	Files []struct {
		Handle string `json:"handle"`
		Name   string `json:"name"`
	} `json:"files"`
}

func (c *Core) thingsSource(in importSource) (things.Source, error) {
	if in.Path != "" {
		return things.Source{Path: in.Path}, nil
	}
	if len(in.Files) == 0 {
		return things.Source{}, errors.New("choose a Things database to import")
	}
	if c.importFiles == nil {
		return things.Source{}, errors.New("uploaded files can’t be read here — choose the database from this device instead")
	}
	var src things.Source
	for _, f := range in.Files {
		data, err := c.importFiles(f.Handle)
		if err != nil {
			return things.Source{}, err
		}
		src.Files = append(src.Files, things.File{Name: f.Name, Data: data})
	}
	return src, nil
}

func (c *Core) importThingsScan(payload []byte) ([]byte, error) {
	var args struct {
		Source   importSource `json:"source"`
		TimeZone string       `json:"timeZone"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	src, err := c.thingsSource(args.Source)
	if err != nil {
		return nil, err
	}
	preview, err := things.Scan(src, things.Options{TimeZone: args.TimeZone})
	if err != nil {
		return nil, err
	}
	return json.Marshal(preview)
}

func (c *Core) importThingsRun(payload []byte) ([]byte, error) {
	var args struct {
		Source           importSource      `json:"source"`
		TimeZone         string            `json:"timeZone"`
		IncludeCompleted bool              `json:"includeCompleted"`
		Selection        *things.Selection `json:"selection"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	src, err := c.thingsSource(args.Source)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.importMu.Lock()
	if c.importCancel != nil {
		c.importMu.Unlock()
		return nil, errors.New("an import is already running")
	}
	c.importCancel = cancel
	c.importMu.Unlock()
	defer func() {
		c.importMu.Lock()
		c.importCancel = nil
		c.importMu.Unlock()
	}()

	summary, err := things.Run(ctx, c.store, src, things.Options{
		TimeZone:         args.TimeZone,
		IncludeCompleted: args.IncludeCompleted,
		Selection:        args.Selection,
	}, func(stage string, done, total int) {
		p, _ := json.Marshal(map[string]any{"source": "things", "stage": stage, "done": done, "total": total})
		c.emit(importProgressEvent, p)
	})
	// Whatever was written is real — even on a failure or a cancel — so every view refreshes.
	c.emit(tasksChangedEvent, nil)
	c.emit(notesChangedEvent, nil)
	c.emit(navChangedEvent, nil)
	c.emitListsChanged("", "")
	if err != nil {
		return nil, err
	}
	return json.Marshal(summary)
}

// importCancel stops the running import after its current batch.
func (c *Core) importCancelRun() ([]byte, error) {
	c.importMu.Lock()
	cancel := c.importCancel
	c.importMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return json.Marshal(map[string]bool{"ok": cancel != nil})
}
