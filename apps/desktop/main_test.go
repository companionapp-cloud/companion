package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDevBuildsKeepDataApartFromRelease(t *testing.T) {
	// os.UserConfigDir reads $HOME on macOS, $XDG_CONFIG_HOME on Linux and %AppData% on Windows.
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", root)
	t.Setenv("AppData", root)
	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}

	release, err := databasePath(false)
	if err != nil {
		t.Fatal(err)
	}
	// Installed copies already keep their data here; moving it would strand it.
	if want := filepath.Join(config, "Companion", "companion.db"); release != want {
		t.Fatalf("release database = %q, want %q", release, want)
	}
	dev, err := databasePath(true)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(dev) == filepath.Dir(release) {
		t.Fatalf("dev and release builds share the data folder %q", filepath.Dir(dev))
	}
	if instanceID(true) == instanceID(false) {
		t.Fatalf("dev and release builds share the single-instance lock %q", instanceID(true))
	}
}
