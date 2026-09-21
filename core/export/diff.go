package export

import "sort"

// Change is one file in a flush. Nil Content deletes the path.
type Change struct {
	Path    string
	Content []byte
	// What the file holds, for the manifest and the commit message.
	EntityType string
	EntityID   string
	// Added is true when the path is new to the destination.
	Added bool

	// An attachment's change carries its hash and size and loads its bytes only when a sink
	// writes it (File).
	SHA  string
	Size int64
	Load func() ([]byte, error)
}

// Deleted reports whether the change removes its path.
func (c Change) Deleted() bool { return c.Content == nil && c.Load == nil }

// Bytes is what to write: the content, or an attachment's bytes, loaded now.
func (c Change) Bytes() ([]byte, error) {
	if c.Load != nil {
		return c.Load()
	}
	return c.Content, nil
}

// ManifestEntry is what a destination holds at one path: whose file it is, and its content hash.
type ManifestEntry struct {
	Path       string
	EntityType string
	EntityID   string
	SHA        string
}

// Diff compares a render with what a destination already holds and returns only the real
// changes: writes for new and changed files, deletes for paths no longer rendered. Because
// paths come from titles and folders, renaming a note or moving it between projects falls out as
// a delete plus a write. An empty manifest rebuilds the destination from scratch. Deletes sort
// first, so a rename that only changes a name's case never deletes the file it just wrote.
func Diff(manifest []ManifestEntry, files []File) []Change {
	held := make(map[string]ManifestEntry, len(manifest))
	for _, m := range manifest {
		held[m.Path] = m
	}
	var deletes, writes []Change
	rendered := make(map[string]bool, len(files))
	for _, f := range files {
		rendered[f.Path] = true
		prev, ok := held[f.Path]
		if ok && prev.SHA == f.SHA() {
			continue
		}
		writes = append(writes, Change{Path: f.Path, Content: f.Content, EntityType: f.EntityType, EntityID: f.EntityID, Added: !ok, SHA: f.SHA(), Size: f.Size, Load: f.Load})
	}
	for _, m := range manifest {
		if !rendered[m.Path] {
			deletes = append(deletes, Change{Path: m.Path, EntityType: m.EntityType, EntityID: m.EntityID})
		}
	}
	sort.Slice(deletes, func(i, j int) bool { return deletes[i].Path < deletes[j].Path })
	sort.Slice(writes, func(i, j int) bool { return writes[i].Path < writes[j].Path })
	return append(deletes, writes...)
}

// Summary counts a change set, for status lines and commit messages.
type Summary struct {
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Removed int `json:"removed"`
}

func Summarize(changes []Change) Summary {
	var s Summary
	for _, c := range changes {
		switch {
		case c.Deleted():
			s.Removed++
		case c.Added:
			s.Added++
		default:
			s.Updated++
		}
	}
	return s
}
