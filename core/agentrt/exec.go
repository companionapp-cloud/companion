//go:build !js

package agentrt

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"companion/core/agents"
)

// maxLine bounds one JSONL line from a CLI (a tool result can embed a whole file).
const maxLine = 16 << 20

// runJSONL starts a CLI with the prompt on stdin, feeds every stdout line to onLine, and
// returns when the process exits. Cancelling ctx kills the process. stderr is captured (tail
// only) and folded into the error so the UI can show "Please run claude login" verbatim.
func runJSONL(ctx context.Context, cwd, path string, args []string, env []string, prompt string, onLine func(line []byte)) error {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.Stdin = strings.NewReader(prompt)
	setProcessGroup(cmd)
	cmd.Cancel = func() error { return killProcessGroup(cmd) }

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr tailBuffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", filepath.Base(path), err)
	}

	scanErr := make(chan error, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64<<10), maxLine)
		for sc.Scan() {
			line := bytes.TrimSpace(sc.Bytes())
			if len(line) == 0 {
				continue
			}
			cp := append([]byte(nil), line...)
			onLine(cp)
		}
		scanErr <- sc.Err()
	}()

	// Drain stdout to EOF before Wait: Wait closes the pipe, and a reader still on it would
	// see "file already closed". A killed child closes its end, so cancellation unblocks this.
	readErr := <-scanErr
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if waitErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = waitErr.Error()
		}
		return fmt.Errorf("%s: %s", filepath.Base(path), msg)
	}
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return readErr
	}
	return nil
}

// sessionErr marks a failed resume as agents.ErrSessionExpired when the CLI says the
// conversation is gone, so the bridge can retry with a fresh session. Other errors pass through.
func sessionErr(req agents.RunRequest, err error) error {
	if err == nil || req.SessionID == "" || !sessionMissing(err.Error()) {
		return err
	}
	return fmt.Errorf("%w: %v", agents.ErrSessionExpired, err)
}

// sessionMissing matches the CLIs' "unknown session" errors: Claude Code's "No conversation
// found with session ID: …" and Codex's "no rollout found for thread id …" / "thread not found".
func sessionMissing(msg string) bool {
	m := strings.ToLower(msg)
	for _, s := range []string{"no conversation found", "no rollout found", "thread not found", "session not found", "conversation not found"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// tailBuffer keeps the last few KB written to it, so a chatty stderr can't grow unbounded but
// the final error message survives.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

const tailMax = 8 << 10

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > tailMax {
		t.buf = t.buf[len(t.buf)-tailMax:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// childEnv builds the environment for a CLI child: the parent's, with Companion-internal vars
// dropped and the binary's own directory prepended to PATH (so a CLI that re-execs itself or
// its node shim resolves). Secrets are never passed by argv.
func childEnv(binaryPath string) []string {
	var env []string
	pathSeen := false
	binDir := filepath.Dir(binaryPath)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "COMPANION_") {
			continue
		}
		if strings.HasPrefix(kv, "PATH=") {
			pathSeen = true
			kv = "PATH=" + binDir + string(os.PathListSeparator) + kv[len("PATH="):]
		}
		env = append(env, kv)
	}
	if !pathSeen {
		env = append(env, "PATH="+binDir+string(os.PathListSeparator)+"/usr/local/bin:/usr/bin:/bin")
	}
	return env
}
