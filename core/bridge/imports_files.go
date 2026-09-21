//go:build !js

package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"companion/core/importer/files"
)

// Importing files (core/importer/files): an explicit, one-time read of a folder of markdown and
// canvas files — a Companion export, an Obsidian vault, any folder of notes — into the
// workspace. It is deliberately not a standing sync: a folder has no history and no way to say
// what changed or what was deleted on purpose, so it is read once, when asked, and only ever
// adds (or, if asked, updates) — it never deletes anything.

// maxImportFiles bounds one import; a vault of tens of thousands of notes is still well under.
const maxImportFiles = 50000

// maxImportAttachment bounds one embedded file.
const maxImportAttachment = 200 << 20

type fileImportArgs struct {
	Path string `json:"path"`
	// UpdateExisting lets files that name an item already in the workspace (by the id in their
	// front matter — i.e. files Companion exported) overwrite it. Off, they are skipped.
	UpdateExisting bool `json:"updateExisting"`
}

// fileImportReport is what a scan or a run found. Problems lists the files that were skipped or
// failed, capped — the counts are always complete.
type fileImportReport struct {
	Root     string          `json:"root"`
	Files    int             `json:"files"`
	Summary  files.Summary   `json:"summary"`
	Problems []files.Outcome `json:"problems"`
}

func readImportFolder(root string) ([]files.File, error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("choose a folder to import")
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("%q isn't a folder that exists", root)
	}
	var out []files.File
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable corner of the tree doesn't stop the import
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if rel != "." && !files.Importable(rel+"/x.md") {
				return filepath.SkipDir // dot-folders: .git, .obsidian, .trash
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if files.Attachable(rel) {
			// A file a note might embed. Its bytes are read only if one does (files.Apply).
			if info, err := d.Info(); err == nil && info.Size() > 0 && info.Size() <= maxImportAttachment {
				full := path
				out = append(out, files.File{Path: rel, Load: func() ([]byte, error) { return os.ReadFile(full) }})
			}
			return nil
		}
		if !files.Importable(rel) {
			return nil
		}
		if len(out) >= maxImportFiles {
			return fmt.Errorf("that folder has more than %d files to import — choose a smaller one", maxImportFiles)
		}
		// An iCloud or Dropbox placeholder for a file that isn't downloaded reads as empty or
		// not at all; either way there's nothing to import.
		content, err := os.ReadFile(path)
		if err != nil || len(content) == 0 {
			return nil
		}
		out = append(out, files.File{Path: rel, Content: content})
		return nil
	})
	return out, err
}

// fileImportIngestor takes attachments in where there's a local blob store to keep them in.
func (c *Core) fileImportIngestor() files.Ingestor {
	if c.attachmentReader() == nil {
		return nil
	}
	return exportAttachments{c}
}

func importReport(root string, count int, outcomes []files.Outcome) fileImportReport {
	// A file no note uses isn't worth a mention — a folder of notes is full of them — so it
	// counts neither as a file found nor as one skipped.
	relevant := outcomes[:0:0]
	for _, o := range outcomes {
		if o.Reason == "no note uses it" {
			count--
			continue
		}
		relevant = append(relevant, o)
	}
	outcomes = relevant
	report := fileImportReport{Root: root, Files: count, Summary: files.Summarize(outcomes), Problems: []files.Outcome{}}
	for _, o := range outcomes {
		if (o.Action == files.Failed || o.Action == files.Skipped) && len(report.Problems) < 100 {
			report.Problems = append(report.Problems, o)
		}
	}
	return report
}

// importFilesScan reports what importing a folder would do, without doing it.
func (c *Core) importFilesScan(payload []byte) ([]byte, error) {
	var args fileImportArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	found, err := readImportFolder(args.Path)
	if err != nil {
		return nil, err
	}
	outcomes := files.Plan(c.store, found, files.Options{Loc: time.Local, UpdateExisting: args.UpdateExisting, Attachments: c.fileImportIngestor()})
	return json.Marshal(importReport(args.Path, len(found), outcomes))
}

// importFilesRun imports the folder.
func (c *Core) importFilesRun(payload []byte) ([]byte, error) {
	var args fileImportArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	found, err := readImportFolder(args.Path)
	if err != nil {
		return nil, err
	}
	outcomes := files.Apply(c.store, found, files.Options{Loc: time.Local, UpdateExisting: args.UpdateExisting, Attachments: c.fileImportIngestor()})
	c.emit(notesChangedEvent, nil)
	c.emitDataChanged("", "")
	return json.Marshal(importReport(args.Path, len(found), outcomes))
}
