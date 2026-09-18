//go:build darwin

package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// runningBundle returns the .app bundle this process runs from (what the updater's helper
// replaces), or "" when the binary isn't inside one (go run, a bare `make desktop` build).
func runningBundle() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	macOS := filepath.Dir(exe)
	contents := filepath.Dir(macOS)
	bundle := filepath.Dir(contents)
	if filepath.Base(macOS) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(bundle) != ".app" {
		return ""
	}
	return bundle
}

// replaceableBundle returns an error when bundle can't be swapped in place. The updater's
// helper copies it to <bundle>.bak beside it, deletes it and renames the new one in, so the
// parent folder and every folder inside the bundle must be writable. That rules out a standard
// (non-admin) account running the app from /Applications, and an app macOS runs from a
// read-only App Translocation mount.
func replaceableBundle(bundle string) error {
	parent := filepath.Dir(bundle)
	if unix.Access(parent, unix.W_OK) != nil {
		return fmt.Errorf("no write access to %s", parent)
	}
	return filepath.WalkDir(bundle, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && unix.Access(path, unix.W_OK) != nil {
			return fmt.Errorf("no write access to %s", path)
		}
		return nil
	})
}

// verifyStagedBundle confirms an unpacked update is what we're about to swap in: a validly
// sealed and signed bundle carrying our bundle identifier and the version we asked for. A stray
// file breaks the seal — notably the AppleDouble ._ entries ditto stores for extended
// attributes, which the updater's zip reader unpacks as real files inside the bundle.
func verifyStagedBundle(staged, wantVersion string) error {
	if filepath.Ext(staged) != ".app" {
		return fmt.Errorf("the update unpacked to %s, not an .app bundle", filepath.Base(staged))
	}
	if out, err := exec.Command("/usr/bin/codesign", "--verify", "--strict", staged).CombinedOutput(); err != nil {
		line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
		if line = strings.TrimPrefix(line, staged+": "); line == "" {
			line = err.Error()
		}
		return fmt.Errorf("the downloaded app failed its signature check: %s", line)
	}
	plist := filepath.Join(staged, "Contents", "Info.plist")
	for _, want := range []struct{ key, value string }{
		{"CFBundleIdentifier", updateBundleID},
		{"CFBundleShortVersionString", wantVersion},
	} {
		out, err := exec.Command("/usr/bin/plutil", "-extract", want.key, "raw", "-o", "-", plist).Output()
		if err != nil {
			return fmt.Errorf("read %s from the downloaded app: %w", want.key, err)
		}
		if got := strings.TrimSpace(string(out)); got != want.value {
			return fmt.Errorf("the downloaded app has %s %q, expected %q", want.key, got, want.value)
		}
	}
	return nil
}
