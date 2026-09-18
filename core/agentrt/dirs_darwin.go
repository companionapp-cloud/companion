//go:build darwin

package agentrt

import (
	"os"
	"path/filepath"
)

// defaultLookupDirs are where CLI installers put binaries on macOS that a GUI app's inherited
// PATH (/usr/bin:/bin:/usr/sbin:/sbin) does not include.
func defaultLookupDirs() []string {
	home, _ := os.UserHomeDir()
	return []string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".claude", "local"),
		filepath.Join(home, ".claude", "local", "node_modules", ".bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		filepath.Join(home, ".npm-global", "bin"),
		filepath.Join(home, ".volta", "bin"),
		filepath.Join(home, ".bun", "bin"),
		filepath.Join(home, ".cargo", "bin"),
		filepath.Join(home, ".nvm", "versions", "node", "*", "bin"),
		filepath.Join(home, "Library", "pnpm"),
		// The Claude desktop app ships its own Claude Code CLI (one dir per version; the glob
		// sorts newest first) — many people have this without ever installing `claude` on PATH.
		filepath.Join(home, "Library", "Application Support", "Claude", "claude-code", "*", "claude.app", "Contents", "MacOS"),
	}
}

// ollamaAppInstalled reports whether the Ollama menu-bar app is present even if its server
// isn't running (so discovery can say "start it" instead of "not found").
func ollamaAppInstalled() bool {
	if _, err := os.Stat("/Applications/Ollama.app"); err == nil {
		return true
	}
	home, _ := os.UserHomeDir()
	_, err := os.Stat(filepath.Join(home, "Applications", "Ollama.app"))
	return err == nil
}
