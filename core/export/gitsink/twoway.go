//go:build !js && !ios && !android

package gitsink

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"

	"companion/core/export"
)

// Two-way sync. Git is the one file format where reading changes back is safe: a commit is an
// atomic snapshot, the last commit synced is an explicit base to compare against, a deletion is
// a recorded fact rather than an absence, and everything is recoverable from history. A cycle is
//
//	Fetch the branch head  →  RemoteChanges(base, head)  →  the caller imports them
//	→  CommitOn(head, what the workspace now renders differently)  →  PushHead
//
// Companion's commits are always made directly on the fetched head, so history stays linear and
// nothing is ever merged or overwritten blind: if the remote moves between the fetch and the
// push, the push is refused (ErrRemoteMoved) and the whole cycle runs again from the new head.

// ErrRemoteMoved means someone pushed between this cycle's fetch and its push. Nothing was
// written to the remote; run the cycle again.
var ErrRemoteMoved = errors.New("the repository changed while syncing")

// maxBlob bounds a note, task or canvas read back from the repository; MaxAttachment bounds an
// attachment, in either direction (the hosts refuse files much beyond this anyway).
const (
	maxBlob       = 8 << 20
	MaxAttachment = 50 << 20
)

// RemoteChange is one owned file that differs between the base and the fetched head. A deletion
// has neither Content nor Load; Base is the file as of the base commit (nil when it's new).
//
// An item's file carries its Content. An attachment's doesn't — it is read from the repository
// only if it is actually imported (Load), and Hash is its sha256 when that's already known.
type RemoteChange struct {
	Path    string
	Content []byte
	Base    []byte

	Size int64
	Load func() ([]byte, error)
}

func (c RemoteChange) Deleted() bool { return c.Content == nil && c.Load == nil }

// Fetch brings in the remote branch's head and returns its hash; "" when the remote has no such
// branch yet (a new, empty repository).
func Fetch(ctx context.Context, cfg Config) (string, error) {
	repo, err := open(cfg)
	if err != nil {
		return "", err
	}
	head, err := fetch(ctx, repo, cfg)
	if err != nil {
		return "", friendly(err)
	}
	if head == nil {
		return "", nil
	}
	return head.Hash.String(), nil
}

// RemoteChanges lists the owned files (export.Owned) that differ between two commits of the
// local repository. base "" means there is no base — a first sync — and every owned file at head
// is reported as new. Both being the same commit, or head being "", is no changes.
func RemoteChanges(cfg Config, base, head string) ([]RemoteChange, error) {
	if head == "" || head == base {
		return nil, nil
	}
	repo, err := open(cfg)
	if err != nil {
		return nil, err
	}
	headTree, err := treeOf(repo, head)
	if err != nil {
		return nil, err
	}
	var baseTree *object.Tree
	if base != "" {
		// A base that's gone (the local repository was rebuilt) is the same as no base.
		if baseTree, err = treeOf(repo, base); err != nil {
			baseTree = nil
		}
	}
	if baseTree == nil {
		return treeFiles(headTree)
	}
	changes, err := baseTree.Diff(headTree)
	if err != nil {
		return nil, fmt.Errorf("compare with the last sync: %w", err)
	}
	var out []RemoteChange
	for _, ch := range changes {
		from, to, err := ch.Files()
		if err != nil {
			return nil, err
		}
		// A rename shows as one change with two names: a deletion of the old path and an
		// addition of the new.
		if from != nil && export.Owned(ch.From.Name) && (to == nil || ch.To.Name != ch.From.Name) {
			gone := RemoteChange{Path: ch.From.Name}
			if !export.IsAttachmentPath(ch.From.Name) {
				if gone.Base, err = blobContent(from); err != nil {
					return nil, err
				}
			}
			out = append(out, gone)
		}
		if to != nil && export.Owned(ch.To.Name) {
			rc, err := remoteFile(ch.To.Name, to)
			if err != nil {
				return nil, err
			}
			if from != nil && ch.From.Name == ch.To.Name && !export.IsAttachmentPath(ch.To.Name) {
				if rc.Base, err = blobContent(from); err != nil {
					return nil, err
				}
			}
			out = append(out, rc)
		}
	}
	return out, nil
}

// HeadFiles is every owned file as of a commit — what a device with no base of its own (a new
// install, or one taking a sync over) reads to work out where it stands.
func HeadFiles(cfg Config, head string) ([]RemoteChange, error) {
	if head == "" {
		return nil, nil
	}
	repo, err := open(cfg)
	if err != nil {
		return nil, err
	}
	tree, err := treeOf(repo, head)
	if err != nil {
		return nil, err
	}
	return treeFiles(tree)
}

func treeFiles(tree *object.Tree) ([]RemoteChange, error) {
	var out []RemoteChange
	err := tree.Files().ForEach(func(f *object.File) error {
		if !export.Owned(f.Name) {
			return nil
		}
		rc, err := remoteFile(f.Name, f)
		if err != nil {
			return err
		}
		out = append(out, rc)
		return nil
	})
	return out, err
}

// remoteFile is a file of the repository as a change: an item's content read now, an
// attachment's left to be read if it's wanted. path is its full path — a File out of a tree
// diff knows only its own name.
func remoteFile(path string, f *object.File) (RemoteChange, error) {
	if export.IsAttachmentPath(path) {
		file := f
		return RemoteChange{Path: path, Size: f.Size, Load: func() ([]byte, error) {
			if file.Size > MaxAttachment {
				return nil, fmt.Errorf("%s is larger than Companion imports (%d MB)", path, MaxAttachment>>20)
			}
			r, err := file.Reader()
			if err != nil {
				return nil, err
			}
			defer r.Close()
			return io.ReadAll(r)
		}}, nil
	}
	content, err := blobContent(f)
	return RemoteChange{Path: path, Content: content, Size: f.Size}, err
}

func treeOf(repo *git.Repository, hash string) (*object.Tree, error) {
	commit, err := repo.CommitObject(plumbing.NewHash(hash))
	if err != nil {
		return nil, err
	}
	return commit.Tree()
}

func blobContent(f *object.File) ([]byte, error) {
	if f.Size > maxBlob {
		return []byte{}, nil // too large to be a note; read as empty and the importer skips it
	}
	r, err := f.Reader()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	content, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	if content == nil {
		content = []byte{}
	}
	return content, nil
}

// CommitOn applies the changes on top of the given commit ("" for a repository with no commits)
// and points the branch at the result. It returns the new commit's hash, or parent itself when
// the changes alter nothing — in which case the branch is simply moved to parent.
//
// An attachment whose bytes aren't on this device yet (export.ErrAttachmentUnavailable) is left
// out of the commit rather than failing it; Skipped reports those paths, which the caller must
// not record as written.
func CommitOn(cfg Config, parent string, changes []export.Change, message string, now time.Time) (string, error) {
	hash, _, err := CommitOnSkipping(cfg, parent, changes, message, now)
	return hash, err
}

func CommitOnSkipping(cfg Config, parent string, changes []export.Change, message string, now time.Time) (hash string, skipped []string, err error) {
	// Load every attachment once, up front, so that one that turns out to be unavailable can be
	// dropped before any tree is built around it.
	ready := make([]export.Change, 0, len(changes))
	for _, ch := range changes {
		if ch.Load != nil {
			if _, err := ch.Bytes(); errors.Is(err, export.ErrAttachmentUnavailable) {
				skipped = append(skipped, ch.Path)
				continue
			} else if err != nil {
				return "", nil, fmt.Errorf("read %s: %w", ch.Path, err)
			}
		}
		ready = append(ready, ch)
	}
	hash, err = commitOn(cfg, parent, ready, message, now)
	return hash, skipped, err
}

func commitOn(cfg Config, parent string, changes []export.Change, message string, now time.Time) (string, error) {
	repo, err := open(cfg)
	if err != nil {
		return "", err
	}
	st := repo.Storer
	var parentCommit *object.Commit
	var base *object.Tree
	if parent != "" {
		if parentCommit, err = repo.CommitObject(plumbing.NewHash(parent)); err != nil {
			return "", fmt.Errorf("read the fetched commit: %w", err)
		}
		if base, err = parentCommit.Tree(); err != nil {
			return "", err
		}
	}
	root := &node{children: map[string]*node{}}
	for i := range changes {
		root.insert(strings.Split(changes[i].Path, "/"), &changes[i])
	}
	tree, empty, err := patchTree(st, base, root)
	if err != nil {
		return "", err
	}
	if empty {
		if tree, err = writeTree(st, nil); err != nil {
			return "", err
		}
	}
	if parentCommit != nil && parentCommit.TreeHash == tree {
		return parent, st.SetReference(plumbing.NewHashReference(cfg.branchRef(), parentCommit.Hash))
	}
	if parentCommit == nil && len(changes) == 0 {
		return "", nil
	}
	var parents []plumbing.Hash
	if parentCommit != nil {
		parents = []plumbing.Hash{parentCommit.Hash}
	}
	hash, err := writeCommit(st, cfg, tree, parents, message, now)
	if err != nil {
		return "", err
	}
	return hash.String(), st.SetReference(plumbing.NewHashReference(cfg.branchRef(), hash))
}

// PushHead sends the branch, fast-forward only. If the remote has moved since the fetch the push
// is refused and ErrRemoteMoved returned — never forced, never re-parented.
func PushHead(ctx context.Context, cfg Config) error {
	repo, err := open(cfg)
	if err != nil {
		return err
	}
	auth, err := cfg.auth()
	if err != nil {
		return err
	}
	err = repo.PushContext(ctx, &git.PushOptions{
		RemoteName: remoteName,
		RefSpecs:   []config.RefSpec{config.RefSpec(cfg.branchRef() + ":" + cfg.branchRef())},
		Auth:       auth,
	})
	switch {
	case err == nil, errors.Is(err, git.NoErrAlreadyUpToDate):
		repackIfLarge(repo)
		return nil
	case nonFastForward(err), strings.Contains(err.Error(), "failed to update ref"), strings.Contains(err.Error(), "fetch first"):
		return ErrRemoteMoved
	}
	return friendly(err)
}
