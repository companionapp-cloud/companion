//go:build !js && !ios && !android

package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"companion/core/export"
	"companion/core/export/gitsink"
	importfiles "companion/core/importer/files"
	"companion/core/store"
)

// exportSupported: this build carries the sinks (desktop). The wasm and mobile cores don't link
// go-git — see export_unsupported.go.
const exportSupported = true

func splitGitCredentials(raw string) (clean, username, token string) {
	return gitsink.SplitCredentials(raw)
}

func isSSHRemote(remote string) bool { return gitsink.IsSSH(remote) }

func generateSSHKey() (private []byte, public string, err error) {
	return gitsink.GenerateKey(exportKeyComment)
}

func sshPublicKey(private []byte) (string, error) {
	return gitsink.PublicKey(private, exportKeyComment)
}

// credentialed fills in how the sink signs in: the secret is an SSH private key for an SSH
// destination, else the token or password that goes with the HTTPS username.
func credentialed(out gitsink.Config, cfg gitConfig, secret string) gitsink.Config {
	if cfg.Auth == gitAuthSSH {
		out.SSHKey, out.HostKey = []byte(secret), cfg.HostKey
		return out
	}
	out.Username, out.Token = cfg.httpUsername(), secret
	return out
}

func (c *Core) gitSinkConfig(dest *store.ExportDestination, cfg gitConfig, secret string) gitsink.Config {
	out := credentialed(gitsink.Config{
		RepoPath: c.exportRepoPath(dest.ID), RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
		AuthorName: cfg.AuthorName, AuthorEmail: cfg.AuthorEmail,
	}, cfg, secret)
	// Trust on first use: the first host key seen is pinned to the destination, and from then on
	// a different one is refused (gitsink).
	if cfg.Auth == gitAuthSSH && cfg.HostKey == "" {
		out.OnHostKey = func(line string) { c.pinExportHostKey(dest.ID, line) }
	}
	if out.AuthorName == "" {
		out.AuthorName = "Companion"
		if c.device.defaultName != "" {
			out.AuthorName = "Companion (" + c.device.defaultName + ")"
		}
	}
	if out.AuthorEmail == "" {
		out.AuthorEmail = "noreply@companionapp.cloud"
	}
	return out
}

func checkGitRemote(ctx context.Context, cfg gitConfig, secret string) error {
	return gitsink.Check(ctx, credentialed(gitsink.Config{RemoteURL: cfg.RemoteURL}, cfg, secret))
}

// pinExportHostKey records the SSH host key a destination met on first contact.
func (c *Core) pinExportHostKey(id, line string) {
	dest, err := c.store.Exports.Get(id)
	if err != nil || dest == nil {
		return
	}
	var cfg gitConfig
	if json.Unmarshal(dest.Config, &cfg) != nil || cfg.HostKey != "" {
		return
	}
	cfg.HostKey = line
	dest.Config, _ = json.Marshal(cfg)
	_ = c.store.Exports.Save(dest)
}

// gitSyncSummary is what one Git sync did, in both directions.
type gitSyncSummary struct {
	export.Summary
	// Pulled: items created or updated from changes made in the repository. Trashed: items moved
	// to the Trash because their files were deleted there. Conflicts: items changed on both
	// sides, where the repository's version was taken and Companion's kept as a copy. Unread:
	// changed files that couldn't be read, and were left as they are.
	Pulled    int `json:"pulled"`
	Trashed   int `json:"trashed"`
	Conflicts int `json:"conflicts"`
	Unread    int `json:"unread"`
	// Waiting: attachments whose bytes aren't on this device yet, sent on a later sync.
	// TooLarge: attachments over the size Git hosts take, which stay out of the repository.
	Waiting  int `json:"waiting,omitempty"`
	TooLarge int `json:"tooLarge,omitempty"`
}

// maxGitSyncAttempts is how often a cycle is rerun because the remote moved under it.
const maxGitSyncAttempts = 3

// syncGit is one two-way Git sync (gitsink/twoway.go for why Git, and only Git, is two-way).
//
//  1. The server first. A Git sync never runs on stale data: it needs a fresh server sync, which
//     is also how this device learns — before it pushes anything — that another device has taken
//     the export over.
//  2. Fetch, and compare the fetched head with the commit last synced. Changes made in the
//     repository are imported as ordinary edits (so they reach the server and every device);
//     deleted files send their items to the Trash; an item changed on both sides takes the
//     repository's version and keeps Companion's as a conflicted copy, as server sync does.
//  3. Render the workspace, commit what differs directly on the fetched head, push. If the
//     remote moved meanwhile the push is refused and the cycle starts over.
//
// The manifest always describes the owned files as of the base commit, so it moves only when a
// push succeeds (or a fetched head is adopted with nothing to push).
func (c *Core) syncGit(ctx context.Context, dest *store.ExportDestination, cfg gitConfig, secret string, force bool) (any, bool, error) {
	if err := c.requireFreshSync(ctx); err != nil {
		return nil, false, err
	}
	// The server may just have said this export is someone else's now, or gone.
	fresh, err := c.store.Exports.Get(dest.ID)
	if err != nil || fresh == nil || !fresh.Enabled || !c.exportsHere(fresh) {
		return nil, false, err
	}
	sink := c.gitSinkConfig(fresh, cfg, secret)
	var total gitSyncSummary
	for attempt := 1; ; attempt++ {
		summary, err := c.syncGitOnce(ctx, fresh, sink, force)
		total.Pulled += summary.Pulled
		total.Trashed += summary.Trashed
		total.Conflicts += summary.Conflicts
		total.Unread, total.Waiting, total.TooLarge = summary.Unread, summary.Waiting, summary.TooLarge
		total.Summary = summary.Summary
		if errors.Is(err, gitsink.ErrRemoteMoved) && attempt < maxGitSyncAttempts {
			continue
		}
		if total.Pulled+total.Trashed+total.Conflicts > 0 {
			// What came in from the repository is local edits now; send them on.
			c.emit(notesChangedEvent, nil)
			c.emitDataChanged("", "")
			c.requestSync()
		}
		return &total, false, err
	}
}

func (c *Core) syncGitOnce(ctx context.Context, dest *store.ExportDestination, sink gitsink.Config, force bool) (gitSyncSummary, error) {
	var summary gitSyncSummary
	base, err := c.store.Exports.BaseCommit(dest.ID)
	if err != nil {
		return summary, err
	}
	head, err := gitsink.Fetch(ctx, sink)
	if err != nil {
		return summary, err
	}
	// What the workspace renders now — needed before anything is imported, to tell a conflict
	// from an edit.
	files, err := export.Render(c.store, time.Local, c.attachmentReader())
	if err != nil {
		return summary, err
	}
	var remote []gitsink.RemoteChange
	if base == "" && head != "" {
		// No base of our own against a repository that already has commits: a new install, or a
		// device taking the sync over. Work out where we stand from the head itself.
		if remote, err = c.adoptGitHead(dest.ID, sink, head, files); err != nil {
			return summary, err
		}
	} else if remote, err = gitsink.RemoteChanges(sink, base, head); err != nil {
		return summary, err
	}
	manifest, err := c.exportManifest(dest.ID)
	if err != nil {
		return summary, err
	}
	held := map[string]export.ManifestEntry{}
	for _, m := range manifest {
		held[m.Path] = m
	}
	local := map[string]export.Change{}
	for _, ch := range export.Diff(manifest, files) {
		local[ch.Path] = ch
	}

	if err := gitDeletionGuard(remote, len(manifest), force); err != nil {
		return summary, err
	}

	// Import what changed in the repository.
	unread := map[string]bool{}
	var incoming []importfiles.File
	known := map[string]importfiles.Ref{}
	for _, rc := range remote {
		entry, tracked := held[rc.Path]
		if rc.Deleted() {
			// Deleted there. If it also changed here, the edit outlives the delete: the file is
			// simply written again. Otherwise the item goes to the Trash.
			if _, changedHere := local[rc.Path]; !changedHere && tracked {
				if err := c.trashFromGit(importfiles.Ref{Type: entry.EntityType, ID: entry.EntityID}); err != nil {
					return summary, err
				}
				summary.Trashed++
			}
			if err := c.store.Exports.ApplyToManifest(dest.ID, nil, []string{rc.Path}); err != nil {
				return summary, err
			}
			continue
		}
		if tracked {
			known[rc.Path] = importfiles.Ref{Type: entry.EntityType, ID: entry.EntityID}
			if _, changedHere := local[rc.Path]; changedHere && rc.Load == nil && entry.SHA != (export.File{Content: rc.Content}).SHA() {
				if c.forkConflict(entry) {
					summary.Conflicts++
				}
			}
		}
		incoming = append(incoming, importfiles.File{Path: rc.Path, Content: rc.Content, Base: rc.Base, Load: rc.Load})
	}
	if len(incoming) > 0 {
		outcomes := importfiles.Apply(c.store, incoming, importfiles.Options{Loc: time.Local, UpdateExisting: true, Known: known, PathsFile: true, Attachments: c.attachmentIngestor()})
		content := map[string][]byte{}
		for _, f := range incoming {
			content[f.Path] = f.Content
		}
		var written []store.ExportManifestRow
		for _, o := range outcomes {
			if o.Action == importfiles.Created || o.Action == importfiles.Updated {
				summary.Pulled++
				sha := export.File{Content: content[o.Path]}.SHA()
				if o.Type == export.KindDocument {
					// An attachment's hash is its document's: it was never read into `content`.
					if doc, err := c.store.Documents.Get(o.ID); err == nil {
						sha = doc.SHA256
					}
				}
				written = append(written, store.ExportManifestRow{Path: o.Path, EntityType: o.Type, EntityID: o.ID, SHA: sha})
			} else {
				// A file that can't be read is left exactly as it is in the repository — not
				// imported, and not overwritten with Companion's version either.
				unread[o.Path] = true
			}
		}
		if err := c.store.Exports.ApplyToManifest(dest.ID, written, nil); err != nil {
			return summary, err
		}
	}
	summary.Unread = len(unread)

	// The workspace as it is now, against the repository as it is now.
	if len(remote) > 0 {
		if files, err = export.Render(c.store, time.Local, c.attachmentReader()); err != nil {
			return summary, err
		}
		if manifest, err = c.exportManifest(dest.ID); err != nil {
			return summary, err
		}
	}
	var changes []export.Change
	for _, ch := range export.Diff(manifest, files) {
		switch {
		case unread[ch.Path]:
		case ch.Size > gitsink.MaxAttachment:
			// Git hosts refuse files much beyond this, and a repository never forgets one.
			summary.TooLarge++
		default:
			changes = append(changes, ch)
		}
	}

	commit, skipped, err := gitsink.CommitOnSkipping(sink, head, changes, exportCommitMessage(changes, export.Summarize(changes)), time.Now())
	if err != nil {
		return summary, err
	}
	if len(skipped) > 0 {
		// Attachments not on this device yet were left out of the commit; don't record them.
		left := map[string]bool{}
		for _, path := range skipped {
			left[path] = true
		}
		sent := changes[:0:0]
		for _, ch := range changes {
			if !left[ch.Path] {
				sent = append(sent, ch)
			}
		}
		changes, summary.Waiting = sent, len(skipped)
	}
	summary.Summary = export.Summarize(changes)
	if commit != head {
		if err := gitsink.PushHead(ctx, sink); err != nil {
			return summary, err
		}
	}
	if err := c.recordExported(dest.ID, changes); err != nil {
		return summary, err
	}
	return summary, c.store.Exports.SetBaseCommit(dest.ID, commit)
}

// trashFromGit trashes the item a deleted file stood for. A note goes the way it does from the
// app — taking the attachments only it embeds to the Trash with it — so deleting a note in the
// repository and deleting it in Companion come to the same thing.
func (c *Core) trashFromGit(ref importfiles.Ref) error {
	if ref.Type != export.KindNote {
		return importfiles.Trash(c.store, ref)
	}
	payload, _ := json.Marshal(map[string]string{"id": ref.ID})
	if _, err := c.notesDelete(payload); err != nil && !errors.Is(err, store.ErrNotFound) && !strings.Contains(err.Error(), "not found") {
		return err
	}
	return nil
}

func (c *Core) attachmentIngestor() importfiles.Ingestor {
	if c.attachmentReader() == nil {
		return nil
	}
	return exportAttachments{c}
}

// adoptGitHead is how a device with no base of its own joins a repository that already has
// commits — a new install, or a device taking the sync over. Treating every file there as a
// change to import would be wrong twice over: it would write the repository's copy (possibly
// weeks old) over newer work that arrived through the server, and — since everything would also
// look changed here — fork a "conflicted copy" of the lot. Instead each file at the head is
// placed, by what Companion itself stamped into it:
//
//   - Same path, same content: in step. Recorded, nothing to do.
//   - Same path, different content, and the file's `updated` stamp matches the item's: Companion
//     hasn't touched the item since it wrote that file, so the difference is an edit made in the
//     repository. It comes in.
//   - Same path, different content otherwise: the item moved on after the file was written. The
//     file is stale and is written again. (A hand edit to a stale file loses to the newer item;
//     it is still in the repository's history.)
//   - A path nothing renders to, holding an item this workspace knows — renamed, moved, trashed
//     or deleted since: a leftover of the previous exporter. Recorded as ours, so it is removed.
//   - A path nothing renders to, holding something this workspace has never seen: new. It comes in.
//
// It returns the files to import; the manifest it writes makes the rest fall out of the ordinary
// diff.
func (c *Core) adoptGitHead(id string, sink gitsink.Config, head string, files []export.File) ([]gitsink.RemoteChange, error) {
	atHead, err := gitsink.HeadFiles(sink, head)
	if err != nil {
		return nil, err
	}
	rendered := make(map[string]export.File, len(files))
	for _, f := range files {
		rendered[f.Path] = f
	}
	var rows []store.ExportManifestRow
	var incoming []gitsink.RemoteChange
	for _, hf := range atHead {
		attachment := export.IsAttachmentPath(hf.Path)
		if r, ok := rendered[hf.Path]; ok {
			row := store.ExportManifestRow{Path: hf.Path, EntityType: r.EntityType, EntityID: r.EntityID, SHA: r.SHA()}
			switch {
			case attachment:
				// Attachments are named for their content; a different size is a different file,
				// and the workspace's is the one that's embedded.
				if hf.Size != r.Size {
					row.SHA = "stale"
				}
			case (export.File{Content: hf.Content}).SHA() == r.SHA():
			case editedInRepository(hf.Content, r.Content):
				incoming = append(incoming, hf)
			default:
				row.SHA = export.File{Content: hf.Content}.SHA()
			}
			rows = append(rows, row)
			continue
		}
		if ref, known := c.knownItem(hf); known {
			rows = append(rows, store.ExportManifestRow{Path: hf.Path, EntityType: ref.Type, EntityID: ref.ID, SHA: "stale"})
			continue
		}
		incoming = append(incoming, hf)
	}
	return incoming, c.store.Exports.ApplyToManifest(id, rows, nil)
}

// editedInRepository reports whether a file that differs from what Companion renders was changed
// by hand rather than left behind: its `updated` stamp — which only Companion writes — still
// matches the item's, so the item hasn't changed since Companion wrote the file.
func editedInRepository(atHead, renderedNow []byte) bool {
	theirs, err := export.ParseMarkdown(atHead)
	if err != nil {
		return false
	}
	ours, err := export.ParseMarkdown(renderedNow)
	if err != nil {
		return false
	}
	return theirs.Get("updated") != "" && theirs.Get("updated") == ours.Get("updated")
}

// knownItem reports whether a file holds an item this workspace has ever had — alive somewhere
// else, in the Trash, or deleted.
func (c *Core) knownItem(hf gitsink.RemoteChange) (importfiles.Ref, bool) {
	place := export.PlaceOf(hf.Path)
	switch {
	case place.Kind == export.KindDocument:
		if hf.Load == nil {
			return importfiles.Ref{}, false
		}
		content, err := hf.Load()
		if err != nil {
			return importfiles.Ref{}, false
		}
		known, err := c.store.Documents.KnownSHA(export.File{Content: content}.SHA())
		return importfiles.Ref{Type: export.KindDocument}, err == nil && known
	case strings.HasSuffix(hf.Path, ".json"):
		canvas, err := export.ParseCanvas(hf.Content)
		if err != nil || canvas.ID == "" {
			return importfiles.Ref{}, false
		}
		_, err = c.store.Canvases.GetAny(canvas.ID)
		return importfiles.Ref{Type: "canvas", ID: canvas.ID}, err == nil
	}
	doc, err := export.ParseMarkdown(hf.Content)
	if err != nil || doc.Get("id") == "" {
		return importfiles.Ref{}, false
	}
	id := doc.Get("id")
	if _, err := c.store.Notes.GetAny(id); err == nil {
		return importfiles.Ref{Type: export.KindNote, ID: id}, true
	}
	if _, err := c.store.Tasks.GetAny(id); err == nil {
		return importfiles.Ref{Type: export.KindTask, ID: id}, true
	}
	return importfiles.Ref{}, false
}

// gitDeletionGuard is the circuit breaker on incoming deletions. A repository that suddenly has
// most of its files missing is far more likely a mistake — a bad merge, a wrong branch, a reset —
// than a decision to bin the workspace, so a large deletion waits for the user to say so
// ("Sync anyway"). Trashed items are recoverable, but thousands of them is still a bad day.
func gitDeletionGuard(remote []gitsink.RemoteChange, tracked int, force bool) error {
	deleted := 0
	for _, rc := range remote {
		if rc.Deleted() {
			deleted++
		}
	}
	if force || deleted <= 20 || deleted*4 <= tracked {
		return nil
	}
	return fmt.Errorf("%d of the %d files Companion keeps in this repository were deleted there. Nothing has been changed. If that's what you meant, choose Sync anyway and their items go to the Trash", deleted, tracked)
}

// forkConflict keeps Companion's version of an item that changed on both sides, as a conflicted
// copy, before the repository's version is applied to it — the same resolution server sync uses.
func (c *Core) forkConflict(entry export.ManifestEntry) bool {
	suffix := "conflicted copy " + time.Now().Format("2006-01-02")
	switch entry.EntityType {
	case export.KindNote:
		if n, err := c.store.Notes.Get(entry.EntityID); err == nil {
			return c.store.Notes.ConflictedCopy(n, suffix) == nil
		}
	case export.KindTask:
		if t, err := c.store.Tasks.Get(entry.EntityID); err == nil {
			return c.store.Tasks.ConflictedCopy(t, suffix) == nil
		}
	}
	return false // a canvas takes the repository's version
}
