//go:build darwin

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// signedBundle builds a minimal ad-hoc signed Companion.app at version (like the release job
// does), using a copy of /usr/bin/true as the executable.
func signedBundle(t *testing.T, version string) string {
	t.Helper()
	app := filepath.Join(t.TempDir(), "Companion.app")
	if err := os.MkdirAll(filepath.Join(app, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	exe, err := os.ReadFile("/usr/bin/true")
	if err != nil {
		t.Skipf("no /usr/bin/true to bundle: %v", err)
	}
	if err := os.WriteFile(filepath.Join(app, "Contents", "MacOS", "companion-desktop"), exe, 0o755); err != nil {
		t.Fatal(err)
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>` + updateBundleID + `</string>
<key>CFBundleExecutable</key><string>companion-desktop</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>` + version + `</string>
</dict></plist>`
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("codesign", "--force", "--sign", "-", "--identifier", updateBundleID, app).CombinedOutput(); err != nil {
		t.Skipf("codesign unavailable: %v: %s", err, out)
	}
	return app
}

func TestVerifyStagedBundle(t *testing.T) {
	app := signedBundle(t, "0.7.0")
	if err := verifyStagedBundle(app, "0.7.0"); err != nil {
		t.Fatalf("a sealed 0.7.0 bundle failed verification: %v", err)
	}
	if err := verifyStagedBundle(app, "0.8.0"); err == nil || !strings.Contains(err.Error(), "CFBundleShortVersionString") {
		t.Fatalf("verifying as 0.8.0: %v, want a version mismatch", err)
	}
	if err := verifyStagedBundle(filepath.Dir(app), "0.7.0"); err == nil {
		t.Fatal("accepted a directory that isn't an .app bundle")
	}
}

// An AppleDouble file is what ditto adds to a zip for an extended attribute; unpacked by the
// updater it lands inside the bundle and breaks the seal.
func TestVerifyStagedBundleRejectsAStrayFile(t *testing.T) {
	app := signedBundle(t, "0.7.0")
	if err := os.WriteFile(filepath.Join(app, "Contents", "._Info.plist"), []byte("appledouble"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyStagedBundle(app, "0.7.0"); err == nil || !strings.Contains(err.Error(), "signature check") {
		t.Fatalf("verify = %v, want a signature failure", err)
	}
}

func TestVerifyStagedBundleRejectsAnotherApp(t *testing.T) {
	app := signedBundle(t, "0.7.0")
	plist := filepath.Join(app, "Contents", "Info.plist")
	if out, err := exec.Command("plutil", "-replace", "CFBundleIdentifier", "-string", "com.example.other", plist).CombinedOutput(); err != nil {
		t.Fatalf("plutil: %v: %s", err, out)
	}
	if out, err := exec.Command("codesign", "--force", "--sign", "-", app).CombinedOutput(); err != nil {
		t.Fatalf("codesign: %v: %s", err, out)
	}
	if err := verifyStagedBundle(app, "0.7.0"); err == nil || !strings.Contains(err.Error(), "CFBundleIdentifier") {
		t.Fatalf("verify = %v, want a bundle identifier mismatch", err)
	}
}

func TestReplaceableBundle(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write anywhere")
	}
	parent := t.TempDir()
	app := filepath.Join(parent, "Companion.app")
	macOS := filepath.Join(app, "Contents", "MacOS")
	if err := os.MkdirAll(macOS, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceableBundle(app); err != nil {
		t.Fatalf("a bundle in a writable folder: %v", err)
	}

	lock := func(dir string) {
		t.Helper()
		if err := os.Chmod(dir, 0o555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(dir, 0o755) })
	}
	lock(macOS)
	if err := replaceableBundle(app); err == nil || !strings.Contains(err.Error(), macOS) {
		t.Fatalf("read-only Contents/MacOS: %v, want it named", err)
	}
	os.Chmod(macOS, 0o755)
	lock(parent)
	if err := replaceableBundle(app); err == nil || !strings.Contains(err.Error(), parent) {
		t.Fatalf("read-only parent folder: %v, want it named", err)
	}
}

func TestRunningBundleOutsideAnApp(t *testing.T) {
	// `go test` runs a bare binary from a temp dir, like `go run`.
	if got := runningBundle(); got != "" {
		t.Fatalf("runningBundle() = %q outside an .app", got)
	}
}
