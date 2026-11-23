package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"companion/core/mcp"
)

// Terminal agents (core/bridge/terminal.go): `companion mcp` is the stdio MCP server that Claude
// Code and Codex start from the user's terminal. It is this same binary run with an argument, and
// it never opens the database: it relays each message to the running app, starting it if needed.

// backgroundArg is passed when the proxy launches the app, so it comes up in the menu bar
// without its window.
const backgroundArg = "--background"

// runMCPProxy serves `companion mcp` until the client closes stdin.
func runMCPProxy(dev bool) {
	dbPath, err := databasePath(dev)
	if err != nil {
		fmt.Fprintln(os.Stderr, "companion mcp:", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	proxy := &mcp.Proxy{
		ConfigPath: filepath.Join(filepath.Dir(dbPath), mcp.TerminalConfigFile),
		LaunchWait: 30 * time.Second,
	}
	if app := appBundlePath(); app != "" {
		proxy.Launch = func() error {
			return exec.Command("/usr/bin/open", "-g", "-a", app, "--args", backgroundArg).Run()
		}
	}
	if err := proxy.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "companion mcp:", err)
		os.Exit(1)
	}
}

// appBundlePath is the Companion.app this binary belongs to, following the symlink Homebrew puts
// on PATH; empty when it isn't running from a bundle (a raw dev build) or not on macOS.
func appBundlePath() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	i := strings.Index(exe, ".app/Contents/MacOS/")
	if i < 0 {
		return ""
	}
	return exe[:i+len(".app")]
}

// terminalCommand is what Settings tells the user to run: plain `companion` when the Homebrew
// link on PATH points at this binary, else the binary's absolute path. A GUI app's PATH lacks
// Homebrew's bin directories, so look in them directly.
func terminalCommand() string {
	exe, err := os.Executable()
	if err != nil {
		return "companion"
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
		if target, err := filepath.EvalSymlinks(filepath.Join(dir, "companion")); err == nil && target == exe {
			return "companion"
		}
	}
	return exe
}
