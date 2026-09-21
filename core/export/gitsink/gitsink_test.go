//go:build !js && !ios && !android

package gitsink

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"companion/core/export"
)

// run executes system git — the independent check that what go-git wrote is a real repository.
// go-git's local transport also shells out to it, so these tests skip where git isn't installed.
func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=Someone", "GIT_AUTHOR_EMAIL=someone@example.com", "GIT_COMMITTER_NAME=Someone", "GIT_COMMITTER_EMAIL=someone@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func setup(t *testing.T) (Config, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	remote := filepath.Join(dir, "remote.git")
	run(t, dir, "init", "--bare", "--initial-branch=main", remote)
	return Config{RepoPath: filepath.Join(dir, "local.git"), RemoteURL: remote, Branch: "main", AuthorName: "Companion", AuthorEmail: "noreply@example.com"}, remote
}

func write(path, content string) export.Change {
	return export.Change{Path: path, Content: []byte(content), Added: true}
}

func TestCommitAndPush(t *testing.T) {
	cfg, remote := setup(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)

	first, err := Commit(ctx, cfg, []export.Change{
		write("Notes/Plan.md", "plan\n"),
		write("Areas/Work/Launch/Tasks/Ship it.md", "ship\n"),
		write("Areas/Work/Launch/Notes/Brief.md", "brief\n"),
	}, "Export: 3 added", now)
	if err != nil || first == "" {
		t.Fatalf("first commit: %q, %v", first, err)
	}
	// Nothing changed → no commit.
	if again, err := Commit(ctx, cfg, []export.Change{write("Notes/Plan.md", "plan\n")}, "noop", now); err != nil || again != "" {
		t.Fatalf("no-op commit: %q, %v", again, err)
	}
	// An edit, a delete that empties a folder, and a delete of something that was never there.
	second, err := Commit(ctx, cfg, []export.Change{
		{Path: "Notes/Plan.md", Content: []byte("plan v2\n")},
		{Path: "Areas/Work/Launch/Tasks/Ship it.md"},
		{Path: "Notes/Never existed.md"},
	}, "Export: 1 updated, 1 removed", now.Add(time.Minute))
	if err != nil || second == "" || second == first {
		t.Fatalf("second commit: %q, %v", second, err)
	}

	if err := Push(ctx, cfg, now); err != nil {
		t.Fatalf("push: %v", err)
	}
	if err := Push(ctx, cfg, now); err != nil {
		t.Fatalf("idempotent push: %v", err)
	}

	run(t, cfg.RepoPath, "fsck", "--strict")
	run(t, remote, "fsck", "--strict")
	if got := run(t, remote, "rev-parse", "main"); got != second {
		t.Errorf("remote head = %s, want %s", got, second)
	}
	files := run(t, remote, "ls-tree", "-r", "--name-only", "main")
	if want := "Areas/Work/Launch/Notes/Brief.md\nNotes/Plan.md"; files != want {
		t.Errorf("tree =\n%s\nwant\n%s", files, want)
	}
	if got := run(t, remote, "show", "main:Notes/Plan.md"); got != "plan v2" {
		t.Errorf("content = %q", got)
	}
	if got := run(t, remote, "log", "-1", "--format=%an <%ae> %s", "main"); got != "Companion <noreply@example.com> Export: 1 updated, 1 removed" {
		t.Errorf("log = %q", got)
	}
}

// Someone else pushed to the branch: the export lands on top of their commit, and its tree wins.
func TestPushOverDivergedRemote(t *testing.T) {
	cfg, remote := setup(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	if _, err := Commit(ctx, cfg, []export.Change{write("Notes/A.md", "a\n")}, "Export: 1 added", now); err != nil {
		t.Fatal(err)
	}
	if err := Push(ctx, cfg, now); err != nil {
		t.Fatal(err)
	}

	clone := filepath.Join(t.TempDir(), "clone")
	run(t, filepath.Dir(clone), "clone", remote, clone)
	if err := os.WriteFile(filepath.Join(clone, "README.md"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, clone, "add", ".")
	run(t, clone, "commit", "-m", "theirs")
	run(t, clone, "push", "origin", "main")
	theirs := run(t, clone, "rev-parse", "HEAD")

	if _, err := Commit(ctx, cfg, []export.Change{write("Notes/B.md", "b\n")}, "Export: 1 added", now); err != nil {
		t.Fatal(err)
	}
	if err := Push(ctx, cfg, now); err != nil {
		t.Fatalf("push over diverged remote: %v", err)
	}
	run(t, remote, "fsck", "--strict")
	if got := run(t, remote, "rev-parse", "main^"); got != theirs {
		t.Errorf("export should sit on their commit: parent %s, want %s", got, theirs)
	}
	if got := run(t, remote, "ls-tree", "-r", "--name-only", "main"); got != "Notes/A.md\nNotes/B.md" {
		t.Errorf("tree = %q", got)
	}
}

// A fresh local repository (a reinstall) continues the remote's history instead of forking it.
func TestNewRepositoryAdoptsRemote(t *testing.T) {
	cfg, remote := setup(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	if _, err := Commit(ctx, cfg, []export.Change{write("Notes/A.md", "a\n")}, "one", now); err != nil {
		t.Fatal(err)
	}
	if err := Push(ctx, cfg, now); err != nil {
		t.Fatal(err)
	}
	firstHead := run(t, remote, "rev-parse", "main")

	if err := Remove(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := Commit(ctx, cfg, []export.Change{write("Notes/B.md", "b\n")}, "two", now); err != nil {
		t.Fatal(err)
	}
	if err := Push(ctx, cfg, now); err != nil {
		t.Fatal(err)
	}
	if got := run(t, remote, "rev-parse", "main^"); got != firstHead {
		t.Errorf("parent = %s, want %s", got, firstHead)
	}
	if got := run(t, remote, "ls-tree", "-r", "--name-only", "main"); got != "Notes/A.md\nNotes/B.md" {
		t.Errorf("tree = %q", got)
	}
}

func TestSplitCredentials(t *testing.T) {
	clean, user, token := SplitCredentials(" https://me:ghp_secret@github.com/me/notes.git ")
	if clean != "https://github.com/me/notes.git" || user != "me" || token != "ghp_secret" {
		t.Errorf("got %q %q %q", clean, user, token)
	}
	if clean, user, token := SplitCredentials("https://github.com/me/notes.git"); clean != "https://github.com/me/notes.git" || user != "" || token != "" {
		t.Errorf("plain url: %q %q %q", clean, user, token)
	}
}
