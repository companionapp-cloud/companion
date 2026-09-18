//go:build !darwin && !js

package agentrt

import (
	"os"
	"path/filepath"
	"runtime"
)

// defaultLookupDirs are the common user-level install locations on Linux and Windows.
func defaultLookupDirs() []string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		appData := os.Getenv("APPDATA")
		local := os.Getenv("LOCALAPPDATA")
		return []string{
			filepath.Join(appData, "npm"),
			filepath.Join(local, "Programs", "claude"),
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".volta", "bin"),
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, ".cargo", "bin"),
		}
	}
	return []string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".claude", "local"),
		"/usr/local/bin",
		"/snap/bin",
		filepath.Join(home, ".npm-global", "bin"),
		filepath.Join(home, ".volta", "bin"),
		filepath.Join(home, ".bun", "bin"),
		filepath.Join(home, ".cargo", "bin"),
		filepath.Join(home, ".nvm", "versions", "node", "*", "bin"),
	}
}

// ollamaAppInstalled has no GUI-app equivalent to check here; the binary probe covers it.
func ollamaAppInstalled() bool { return false }
