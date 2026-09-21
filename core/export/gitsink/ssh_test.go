//go:build !js && !ios && !android

package gitsink

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"companion/core/export"
)

// sshGitServer is a minimal Git-over-SSH host: it accepts one authorized key and runs the
// requested git-upload-pack / git-receive-pack with system git. hostSigner can be swapped to
// play a host whose key changed.
type sshGitServer struct {
	addr       string
	mu         sync.Mutex
	hostSigner ssh.Signer
	authorized string // authorized_keys line (no comment)
}

func newSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func startSSHGitServer(t *testing.T) *sshGitServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	s := &sshGitServer{addr: ln.Addr().String(), hostSigner: newSigner(t)}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(conn)
		}
	}()
	return s
}

func (s *sshGitServer) serve(conn net.Conn) {
	defer conn.Close()
	s.mu.Lock()
	host, authorized := s.hostSigner, s.authorized
	s.mu.Unlock()
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		if strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))) == authorized {
			return nil, nil
		}
		return nil, fmt.Errorf("unknown key")
	}}
	cfg.AddHostKey(host)
	sc, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			nc.Reject(ssh.UnknownChannelType, "")
			continue
		}
		ch, requests, err := nc.Accept()
		if err != nil {
			return
		}
		go func() {
			defer ch.Close()
			for req := range requests {
				if req.Type != "exec" {
					req.Reply(req.Type == "env", nil)
					continue
				}
				var payload struct{ Command string }
				ssh.Unmarshal(req.Payload, &payload)
				// "git-upload-pack '/path'" → git upload-pack /path
				parts := strings.SplitN(payload.Command, " ", 2)
				if len(parts) != 2 || !strings.HasPrefix(parts[0], "git-") {
					req.Reply(false, nil)
					return
				}
				req.Reply(true, nil)
				cmd := exec.Command("git", strings.TrimPrefix(parts[0], "git-"), strings.Trim(parts[1], "'"))
				stdin, _ := cmd.StdinPipe()
				cmd.Stdout, cmd.Stderr = ch, ch.Stderr()
				go func() { io.Copy(stdin, ch); stdin.Close() }()
				status := uint32(0)
				if err := cmd.Run(); err != nil {
					status = 1
				}
				ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
				return
			}
		}()
	}
}

func TestSSHExport(t *testing.T) {
	cfg, remote := setup(t)
	server := startSSHGitServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)

	private, public, err := GenerateKey("Companion export")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(public, "ssh-ed25519 ") || !strings.HasSuffix(public, " Companion export") {
		t.Fatalf("public key = %q", public)
	}
	if again, err := PublicKey(private, "Companion export"); err != nil || again != public {
		t.Fatalf("PublicKey round trip = %q, %v", again, err)
	}
	cfg.RemoteURL = "ssh://git@" + server.addr + remote
	cfg.SSHKey = private
	if !IsSSH(cfg.RemoteURL) || !IsSSH("git@github.com:me/notes.git") || IsSSH("https://github.com/me/notes.git") {
		t.Fatal("IsSSH misjudged a remote")
	}

	// Before the deploy key is added, the host refuses — with words the user can act on.
	if err := Check(ctx, cfg); err == nil || !strings.Contains(err.Error(), "didn't accept the SSH key") {
		t.Fatalf("check without an authorized key: %v", err)
	}
	server.mu.Lock()
	server.authorized = strings.TrimSuffix(public, " Companion export")
	server.mu.Unlock()

	// First contact pins the host key.
	var pinned string
	cfg.OnHostKey = func(line string) { pinned = line }
	if err := Check(ctx, cfg); err != nil {
		t.Fatalf("check: %v", err)
	}
	if !strings.HasPrefix(pinned, "ssh-ed25519 ") {
		t.Fatalf("the host key should be reported for pinning, got %q", pinned)
	}
	cfg.HostKey, cfg.OnHostKey = pinned, func(string) { t.Error("a pinned host shouldn't be re-reported") }

	if _, err := Commit(ctx, cfg, []export.Change{write("Notes/A.md", "a\n")}, "Export: 1 added", now); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := Push(ctx, cfg, now); err != nil {
		t.Fatalf("push over ssh: %v", err)
	}
	if got := run(t, remote, "ls-tree", "-r", "--name-only", "main"); got != "Notes/A.md" {
		t.Errorf("remote tree = %q", got)
	}
	run(t, remote, "fsck", "--strict")

	// A host that turns up with a different key is refused, and nothing is sent.
	server.mu.Lock()
	server.hostSigner = newSigner(t)
	server.mu.Unlock()
	if _, err := Commit(ctx, cfg, []export.Change{write("Notes/B.md", "b\n")}, "Export: 1 added", now); err != nil {
		t.Fatal(err)
	}
	if err := Push(ctx, cfg, now); err == nil || !strings.Contains(err.Error(), "SSH key has changed") {
		t.Fatalf("push to a host with a changed key: %v", err)
	}
	if got := run(t, remote, "ls-tree", "-r", "--name-only", "main"); got != "Notes/A.md" {
		t.Errorf("nothing should reach an unverified host, tree = %q", got)
	}
}
