//go:build live && darwin

package main

import (
	"context"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

// TestLiveLatestReleaseInstalls runs the real update path against the latest published
// release, short of swapping it in: GitHub must report it with the macOS zip and its digest,
// the Wails updater must download, verify and unpack it, and the result must pass the checks
// the app makes before restarting into it. Hits the network and downloads the release:
//
//	go test -tags live -run TestLiveLatestReleaseInstalls ./apps/desktop
func TestLiveLatestReleaseInstalls(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	source := newGitHubReleases("https://api.github.com", updateRepo, updateAssetSuffix, "0.0.1")
	u := updater.New(liveHost{})
	if err := u.Init(updater.Config{CurrentVersion: "0.0.1", Providers: []updater.Provider{source}, Window: updater.WindowNone}); err != nil {
		t.Fatal(err)
	}
	rel, err := u.Check(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if rel == nil {
		t.Fatal("no release newer than 0.0.1 with a macOS zip")
	}
	t.Logf("latest: %s (%s, %d bytes)", rel.Version, rel.Artifact.Filename, rel.Artifact.Size)
	if err := u.DownloadAndInstall(ctx); err != nil {
		t.Fatal(err)
	}
	staged := u.DownloadedPath()
	t.Cleanup(func() { discardStaged(staged) })
	if err := verifyStagedBundle(staged, rel.Version); err != nil {
		t.Fatal(err)
	}
}

type liveHost struct{}

func (liveHost) Emit(string, ...any) bool                              { return true }
func (liveHost) OnEvent(string, func(any)) func()                      { return func() {} }
func (liveHost) OpenWindow(updater.WindowOptions) updater.WindowHandle { return nil }
func (liveHost) Quit()                                                 {}
