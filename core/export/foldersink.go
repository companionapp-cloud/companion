package export

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// FolderSink applies a change set to a folder on disk — a local folder, or one a desktop cloud
// client (iCloud Drive, Dropbox, Google Drive, OneDrive) keeps in sync, which looks the same from
// here. It only ever touches paths the export itself rendered: deletes come from the manifest,
// never from listing the folder, so anything else the user keeps there is left alone.
type FolderSink struct {
	Root string
}

// Apply writes and deletes the changes. It returns the changes that were applied, so a partial
// failure still records what reached the disk, along with the first error.
func (s FolderSink) Apply(changes []Change) ([]Change, error) {
	root, err := filepath.Abs(s.Root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// A missing root is an unplugged drive or a moved folder — not a cue to recreate it
			// somewhere the user isn't looking.
			return nil, fmt.Errorf("the export folder %q isn't there anymore", root)
		}
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%q is not a folder", root)
	}

	var applied []Change
	for _, c := range changes {
		path, err := s.resolve(root, c.Path)
		if err != nil {
			return applied, err
		}
		if c.Deleted() {
			if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return applied, fmt.Errorf("remove %s: %w", c.Path, err)
			}
			pruneEmptyDirs(root, filepath.Dir(path))
		} else {
			content, err := c.Bytes()
			if errors.Is(err, ErrAttachmentUnavailable) {
				continue // not applied, so not recorded: it's written on a later run
			}
			if err != nil {
				return applied, fmt.Errorf("read %s: %w", c.Path, err)
			}
			if err := writeFileAtomic(path, content); err != nil {
				return applied, fmt.Errorf("write %s: %w", c.Path, err)
			}
		}
		applied = append(applied, c)
	}
	return applied, nil
}

// resolve maps a rendered slash path under root, refusing anything that would land outside it.
func (s FolderSink) resolve(root, rel string) (string, error) {
	path := filepath.Join(root, filepath.FromSlash(rel))
	if inside, err := filepath.Rel(root, path); err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) || filepath.IsAbs(inside) {
		return "", fmt.Errorf("export path %q escapes the export folder", rel)
	}
	return path, nil
}

// writeFileAtomic writes beside the destination and renames into place, so a sync client
// watching the folder never sees half a file.
func writeFileAtomic(path string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".companion-export-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// pruneEmptyDirs removes dir and its parents up to (not including) root while they're empty —
// the folders a moved or renamed project leaves behind. os.Remove refuses a non-empty directory,
// which is the check.
func pruneEmptyDirs(root, dir string) {
	for dir != root && strings.HasPrefix(dir, root+string(filepath.Separator)) {
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}
