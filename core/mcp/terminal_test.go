//go:build !js

package mcp

import (
	"bytes"
	"context"
	"net"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"companion/core/llm"
)

// The app isn't running: the proxy starts it once and replays the waiting message to the
// endpoint the app publishes.
func TestProxyLaunchesAppWhenUnreachable(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), TerminalConfigFile)
	// A stale endpoint left by an app that quit: nothing listens there any more.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stale := "http://" + ln.Addr().String() + "/mcp"
	ln.Close()
	if err := WriteTerminalConfig(cfgPath, TerminalConfig{Enabled: true, URL: stale, Token: "old"}); err != nil {
		t.Fatal(err)
	}

	srv := New(llm.NewRegistry(), nil)
	t.Cleanup(srv.Stop)
	var launches atomic.Int32
	p := &Proxy{
		ConfigPath: cfgPath,
		LaunchWait: 5 * time.Second,
		Launch: func() error {
			launches.Add(1)
			go func() {
				time.Sleep(300 * time.Millisecond) // the app takes a moment to come up
				url, _ := srv.Start()
				_ = WriteTerminalConfig(cfgPath, TerminalConfig{Enabled: true, URL: url, Token: srv.IssueToken(Grant{AgentID: "terminal"})})
			}()
			return nil
		},
	}
	var out bytes.Buffer
	in := `{"jsonrpc":"2.0","id":1,"method":"ping"}` + "\n" + `{"jsonrpc":"2.0","id":2,"method":"ping"}` + "\n"
	if err := p.Serve(context.Background(), strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	replies := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(replies) != 2 || strings.Contains(out.String(), "error") {
		t.Fatalf("replies = %q", out.String())
	}
	if n := launches.Load(); n != 1 {
		t.Fatalf("launched %d times, want 1", n)
	}
}

// Without a way to start the app, the proxy says it isn't running instead of hanging.
func TestProxyReportsAppDown(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), TerminalConfigFile)
	if err := WriteTerminalConfig(cfgPath, TerminalConfig{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	p := &Proxy{ConfigPath: cfgPath}
	if err := p.Serve(context.Background(), strings.NewReader(`{"jsonrpc":"2.0","id":"a","method":"initialize"}`+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"id":"a"`) || !strings.Contains(out.String(), "isn't running") {
		t.Fatalf("reply = %s", out.String())
	}
}
