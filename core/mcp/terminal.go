package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Terminal agents are Claude Code or Codex sessions the user starts in their own terminal. They
// reach the desktop app's tools through `companion mcp`, a stdio MCP server (Proxy) that relays
// each message to the app's loopback HTTP server. The two processes meet through one file beside
// the database: the app writes its current URL and token there, the proxy reads them.

// TerminalConfigFile is the name of that file, in the directory that holds companion.db.
const TerminalConfigFile = "terminal-agents.json"

// TerminalConfig is the file's content. Enabled and AllowWrite are the user's settings and
// outlive the app; URL and Token are the running app's endpoint and go stale when it quits.
type TerminalConfig struct {
	Enabled    bool   `json:"enabled"`
	AllowWrite bool   `json:"allowWrite"`
	URL        string `json:"url,omitempty"`
	Token      string `json:"token,omitempty"`
}

// ReadTerminalConfig reads the file; a missing file is the zero config (switched off).
func ReadTerminalConfig(path string) (TerminalConfig, error) {
	var cfg TerminalConfig
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	return cfg, json.Unmarshal(data, &cfg)
}

// WriteTerminalConfig replaces the file atomically, readable by the user only: the token in it
// is a credential for the user's whole workspace.
func WriteTerminalConfig(path string, cfg TerminalConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".terminal-agents-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// The proxy's answers when it cannot reach the app.
const (
	msgTerminalOff = "Companion's terminal agents are switched off. Turn them on in Companion › Settings › AI › Terminal agents, then restart this session."
	msgAppDown     = "Companion isn't running. Open the Companion app, then try again."
)

// Proxy serves MCP over stdio by forwarding each JSON-RPC message to the desktop app.
type Proxy struct {
	// ConfigPath is the TerminalConfigFile to read the endpoint from, before every message.
	ConfigPath string
	// Launch, when set, starts the app; the proxy calls it once, the first time the app is
	// unreachable, then waits up to LaunchWait for the app to publish a fresh endpoint.
	Launch     func() error
	LaunchWait time.Duration
	Client     *http.Client

	launchOnce sync.Once
}

// Serve reads newline-delimited JSON-RPC messages from in and writes the replies to out until
// in closes. Messages are forwarded concurrently, so a slow tool call doesn't hold up a ping.
func (p *Proxy) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	if p.Client == nil {
		p.Client = &http.Client{}
	}
	var (
		wg  sync.WaitGroup
		wmu sync.Mutex
	)
	write := func(b []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		_, _ = out.Write(append(bytes.TrimSpace(b), '\n'))
	}
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 64<<10), 16<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		msg := append([]byte(nil), line...)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if reply := p.handle(ctx, msg); reply != nil {
				write(reply)
			}
		}()
	}
	wg.Wait()
	return sc.Err()
}

// handle forwards one message and returns the reply to write, or nil for none.
func (p *Proxy) handle(ctx context.Context, msg []byte) []byte {
	var head struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(msg, &head); err != nil {
		reply, _ := json.Marshal(rpcResponse{JSONRPC: "2.0", Error: &rpcError{codeParse, "parse error"}})
		return reply
	}
	reply, err := p.forward(ctx, msg)
	if err == nil {
		return reply
	}
	if len(head.ID) == 0 || string(head.ID) == "null" {
		return nil // a notification: nobody is waiting for an answer
	}
	out, _ := json.Marshal(rpcResponse{JSONRPC: "2.0", ID: head.ID, Error: &rpcError{codeInternal, err.Error()}})
	return out
}

// errUnreachable means nothing answered at the endpoint: the app isn't running.
var errUnreachable = errors.New(msgAppDown)

func (p *Proxy) forward(ctx context.Context, msg []byte) ([]byte, error) {
	cfg, err := ReadTerminalConfig(p.ConfigPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", p.ConfigPath, err)
	}
	if !cfg.Enabled {
		return nil, errors.New(msgTerminalOff)
	}
	reply, err := p.post(ctx, cfg, msg)
	if !errors.Is(err, errUnreachable) || p.Launch == nil {
		return reply, err
	}
	// The app isn't running (or restarted onto a new port): start it once, then wait for it to
	// publish an endpoint that answers.
	p.launchOnce.Do(func() { _ = p.Launch() })
	deadline := time.Now().Add(p.LaunchWait)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
		next, err := ReadTerminalConfig(p.ConfigPath)
		if err != nil || !next.Enabled {
			continue
		}
		if reply, err := p.post(ctx, next, msg); !errors.Is(err, errUnreachable) {
			return reply, err
		}
	}
	return nil, errUnreachable
}

// post sends one message to the app. A nil reply with a nil error is a notification's 202.
func (p *Proxy) post(ctx context.Context, cfg TerminalConfig, msg []byte) ([]byte, error) {
	if cfg.URL == "" {
		return nil, errUnreachable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL, bytes.NewReader(msg))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := p.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errUnreachable
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusAccepted:
		return nil, nil
	case resp.StatusCode == http.StatusUnauthorized:
		// A stale token: another process holds the old port, or the app is mid-restart.
		return nil, errUnreachable
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("companion: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return body, nil
}
