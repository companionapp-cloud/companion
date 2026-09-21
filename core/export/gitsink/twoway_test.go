//go:build !js && !ios && !android

package gitsink

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"companion/core/export"
)

func TestTwoWayPrimitives(t *testing.T) {
	cfg, remote := setup(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)

	// An empty remote: nothing to fetch, nothing changed; the first commit has no parent.
	head, err := Fetch(ctx, cfg)
	if err != nil || head != "" {
		t.Fatalf("fetch of an empty remote = %q, %v", head, err)
	}
	base, err := CommitOn(cfg, "", []export.Change{write("Notes/A.md", "a\n"), write("Notes/B.md", "b\n"), write("Tasks/T.md", "t\n")}, "Sync: 3 added", now)
	if err != nil || base == "" {
		t.Fatalf("first commit = %q, %v", base, err)
	}
	if err := PushHead(ctx, cfg); err != nil {
		t.Fatal(err)
	}

	// Someone edits the repository: changes one file, deletes one, adds one, renames one, and
	// touches a file that isn't ours.
	clone := filepath.Join(t.TempDir(), "clone")
	run(t, filepath.Dir(clone), "clone", remote, clone)
	os.WriteFile(filepath.Join(clone, "Notes/A.md"), []byte("a, edited\n"), 0o644)
	os.Remove(filepath.Join(clone, "Notes/B.md"))
	os.WriteFile(filepath.Join(clone, "Notes/New.md"), []byte("new\n"), 0o644)
	run(t, clone, "mv", "Tasks/T.md", "Tasks/Renamed.md")
	os.WriteFile(filepath.Join(clone, "README.md"), []byte("not ours\n"), 0o644)
	run(t, clone, "add", "-A")
	run(t, clone, "commit", "-m", "edits from elsewhere")
	run(t, clone, "push", "origin", "main")

	head, err = Fetch(ctx, cfg)
	if err != nil || head == "" || head == base {
		t.Fatalf("fetch = %q, %v", head, err)
	}
	changes, err := RemoteChanges(cfg, base, head)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range changes {
		line := c.Path + " = " + strings.TrimSpace(string(c.Content))
		if c.Deleted() {
			line = c.Path + " deleted (was " + strings.TrimSpace(string(c.Base)) + ")"
		} else if c.Base != nil {
			line += " (was " + strings.TrimSpace(string(c.Base)) + ")"
		}
		got = append(got, line)
	}
	sort.Strings(got)
	want := []string{"Notes/A.md = a, edited (was a)", "Notes/B.md deleted (was b)", "Notes/New.md = new", "Tasks/Renamed.md = t", "Tasks/T.md deleted (was t)"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("remote changes =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if same, _ := RemoteChanges(cfg, head, head); len(same) != 0 {
		t.Errorf("no changes between a commit and itself, got %d", len(same))
	}
	if all, _ := RemoteChanges(cfg, "", head); len(all) != 3 {
		t.Errorf("with no base every owned file is new, got %d", len(all))
	}

	// Our change goes on top of theirs; their README is untouched.
	next, err := CommitOn(cfg, head, []export.Change{{Path: "Notes/A.md", Content: []byte("a, edited twice\n")}}, "Sync: 1 updated", now)
	if err != nil || next == head {
		t.Fatalf("commit on head = %q, %v", next, err)
	}
	// Nothing to say: the branch just moves to the head.
	if same, err := CommitOn(cfg, next, nil, "noop", now); err != nil || same != next {
		t.Errorf("an empty commit should be skipped: %q, %v", same, err)
	}

	// The remote moves again before we push: refused, not forced.
	os.WriteFile(filepath.Join(clone, "Notes/New.md"), []byte("new, again\n"), 0o644)
	run(t, clone, "commit", "-am", "raced")
	run(t, clone, "push", "origin", "main")
	raced := run(t, clone, "rev-parse", "HEAD")
	if err := PushHead(ctx, cfg); !errors.Is(err, ErrRemoteMoved) {
		t.Fatalf("push after the remote moved = %v, want ErrRemoteMoved", err)
	}
	if got := run(t, remote, "rev-parse", "main"); got != raced {
		t.Errorf("a refused push must leave the remote alone: %s", got)
	}

	// Run again from the new head, and it lands.
	head2, _ := Fetch(ctx, cfg)
	if _, err := CommitOn(cfg, head2, []export.Change{{Path: "Notes/A.md", Content: []byte("a, edited twice\n")}}, "Sync: 1 updated", now); err != nil {
		t.Fatal(err)
	}
	if err := PushHead(ctx, cfg); err != nil {
		t.Fatalf("second attempt: %v", err)
	}
	run(t, remote, "fsck", "--strict")
	if got := run(t, remote, "log", "--format=%s", "main"); got != "Sync: 1 updated\nraced\nedits from elsewhere\nSync: 3 added" {
		t.Errorf("history should be linear:\n%s", got)
	}
	if got := run(t, remote, "show", "main:README.md"); got != "not ours" {
		t.Errorf("README = %q", got)
	}
}
