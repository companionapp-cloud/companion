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
	"companion/desktop/term"
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

// runTerminalCommand runs `companion tui|new|rex`, reporting whether name was one of them.
func runTerminalCommand(dev bool, name string, args []string) bool {
	if name != "tui" && name != "new" && name != "rex" {
		return false
	}
	dbPath, err := databasePath(dev)
	if err != nil {
		fmt.Fprintln(os.Stderr, "companion:", err)
		os.Exit(1)
	}
	client := &term.Client{ConfigPath: filepath.Join(filepath.Dir(dbPath), mcp.TerminalConfigFile)}
	if app := appBundlePath(); app != "" {
		client.Launch = func() error {
			return exec.Command("/usr/bin/open", "-g", "-a", app, "--args", backgroundArg).Run()
		}
	}
	switch name {
	case "tui":
		start := ""
		if len(args) > 0 {
			start = args[0]
		}
		err = term.RunTUI(client, term.StartTab(start))
	case "new":
		err = term.RunNew(client, args, os.Stdout)
	case "rex":
		if len(args) != 1 || args[0] != "install" {
			err = fmt.Errorf("usage: companion rex install")
			break
		}
		err = term.RexInstall(terminalCommand(), os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "companion:", err)
		os.Exit(1)
	}
	return true
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
