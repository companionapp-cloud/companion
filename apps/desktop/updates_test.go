package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

func TestVersionNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.7.0", "0.6.1", true},
		{"0.6.1", "0.6.1", false},
		{"0.6.0", "0.6.1", false},
		{"1.10.0", "1.9.2", true},
		{"v1.0.0", "0.9", true},
		{"1.0", "1.0.0", false},
		{"0.7.0", "0.7.0-rc1", true},
		{"0.7.0-rc1", "0.7.0", false},
		{"0.7.0-rc2", "0.7.0-rc1", true},
		{"1.2.3+build.5", "1.2.3", false},
	}
	for _, c := range cases {
		got, err := versionNewer(c.a, c.b)
		if err != nil {
			t.Fatalf("versionNewer(%q, %q): %v", c.a, c.b, err)
		}
		if got != c.want {
			t.Errorf("versionNewer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
	for _, bad := range []string{"", "dev", "1.2.3.4", "1.x.0", "-1.0.0"} {
		if _, err := versionNewer(bad, "1.0.0"); err == nil {
			t.Errorf("versionNewer(%q, \"1.0.0\") accepted an invalid version", bad)
		}
	}
}

// --- the GitHub release source ---

const testRepo = "companionapp-cloud/companion"

// fakeGitHub stands in for api.github.com (/repos/<repo>/releases/latest) and the asset
// download host.
type fakeGitHub struct {
	*httptest.Server
	mu      sync.Mutex
	latest  func(w http.ResponseWriter, r *http.Request)
	assets  map[string][]byte
	headers []http.Header
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	f := &fakeGitHub{assets: map[string][]byte{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/"+testRepo+"/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.headers = append(f.headers, r.Header.Clone())
		latest := f.latest
		f.mu.Unlock()
		latest(w, r)
	})
	mux.HandleFunc("/download/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		body, ok := f.assets[strings.TrimPrefix(r.URL.Path, "/download/")]
		f.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

// handle answers /releases/latest with fn.
func (f *fakeGitHub) handle(fn func(w http.ResponseWriter, r *http.Request)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.latest = fn
}

// serve answers /releases/latest with rel as JSON.
func (f *fakeGitHub) serve(rel ghRelease) {
	f.handle(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rel)
	})
}

// header returns the headers of the i'th /releases/latest request.
func (f *fakeGitHub) header(i int) http.Header {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.headers[i]
}

// zip registers an asset download and returns the release asset describing it.
func (f *fakeGitHub) zip(name string, body []byte) ghAsset {
	f.mu.Lock()
	f.assets[name] = body
	f.mu.Unlock()
	sum := sha256.Sum256(body)
	return ghAsset{
		Name:               name,
		Size:               int64(len(body)),
		Digest:             "sha256:" + hex.EncodeToString(sum[:]),
		BrowserDownloadURL: f.URL + "/download/" + name,
	}
}

func (f *fakeGitHub) source() *githubReleases {
	return newGitHubReleases(f.URL, testRepo, updateAssetSuffix, "0.6.1")
}

func release(tag string, assets ...ghAsset) ghRelease {
	return ghRelease{TagName: tag, Name: tag, HTMLURL: "https://github.com/" + testRepo + "/releases/tag/" + tag, Assets: assets}
}

var macOS = updater.CheckRequest{CurrentVersion: "0.6.1", Platform: "darwin", Arch: "arm64"}

func TestGitHubReleasesPicksTheMacZipAndItsDigest(t *testing.T) {
	gh := newFakeGitHub(t)
	zip := gh.zip("Companion-0.7.0-macos-universal.zip", []byte("PK zip bytes"))
	// Listed first on purpose: it's what a "darwin + arch" matcher would pick.
	server := gh.zip("companion-server-darwin-arm64", []byte("server"))
	gh.serve(release("v0.7.0", server, zip))

	rel, err := gh.source().Check(context.Background(), macOS)
	if err != nil {
		t.Fatal(err)
	}
	if rel == nil {
		t.Fatal("Check found no update, want 0.7.0")
	}
	if rel.Version != "0.7.0" || rel.Artifact.Filename != zip.Name || rel.Artifact.Size != zip.Size {
		t.Fatalf("Check = %s %s (%d bytes), want 0.7.0 %s (%d bytes)", rel.Version, rel.Artifact.Filename, rel.Artifact.Size, zip.Name, zip.Size)
	}
	sum := sha256.Sum256([]byte("PK zip bytes"))
	if v := rel.Verification; v == nil || v.DigestAlgo != "sha256" || !bytes.Equal(v.Digest, sum[:]) {
		t.Fatalf("Verification = %+v, want the zip's sha256", rel.Verification)
	}
	if got := rel.Metadata[metaDownloadURL]; got != zip.BrowserDownloadURL {
		t.Fatalf("download URL = %v, want %s", got, zip.BrowserDownloadURL)
	}
	if got := rel.Metadata[metaReleaseURL]; got != "https://github.com/"+testRepo+"/releases/tag/v0.7.0" {
		t.Fatalf("release URL = %v", got)
	}
	if ua := gh.header(0).Get("User-Agent"); ua != "Companion/0.6.1" {
		t.Fatalf("User-Agent = %q, want Companion/0.6.1", ua)
	}
}

func TestGitHubReleasesFindsNothingNew(t *testing.T) {
	gh := newFakeGitHub(t)
	zip := func(v string) ghAsset { return gh.zip("Companion-"+v+"-macos-universal.zip", []byte(v)) }
	cases := map[string]func(){
		"same version":  func() { gh.serve(release("v0.6.1", zip("0.6.1"))) },
		"older version": func() { gh.serve(release("v0.6.0", zip("0.6.0"))) },
		"marked prerelease": func() {
			rel := release("v0.7.0", zip("0.7.0"))
			rel.Prerelease = true
			gh.serve(rel)
		},
		"unmarked rc tag": func() { gh.serve(release("v0.7.0-rc1", zip("0.7.0-rc1"))) },
		"mac zip still uploading": func() {
			gh.serve(release("v0.7.0", gh.zip("companion-server-darwin-arm64", []byte("server"))))
		},
		"no releases yet": func() { gh.handle(http.NotFound) },
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			setup()
			rel, err := gh.source().Check(context.Background(), macOS)
			if err != nil || rel != nil {
				t.Fatalf("Check = %+v, %v; want nothing new", rel, err)
			}
		})
	}
}

func TestGitHubReleasesFailsClosedWithoutADigest(t *testing.T) {
	gh := newFakeGitHub(t)
	zip := gh.zip("Companion-0.7.0-macos-universal.zip", []byte("PK"))
	zip.Digest = ""
	gh.serve(release("v0.7.0", zip))
	if _, err := gh.source().Check(context.Background(), macOS); err == nil || !strings.Contains(err.Error(), "no sha256 digest") {
		t.Fatalf("Check error = %v, want a missing-digest error", err)
	}
}

func TestGitHubReleasesRevalidatesWithETag(t *testing.T) {
	gh := newFakeGitHub(t)
	zip := gh.zip("Companion-0.7.0-macos-universal.zip", []byte("PK"))
	body, _ := json.Marshal(release("v0.7.0", zip))
	gh.handle(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"v7"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v7"`)
		w.Write(body)
	})
	source := gh.source()
	for i := 0; i < 2; i++ {
		rel, err := source.Check(context.Background(), macOS)
		if err != nil || rel == nil || rel.Version != "0.7.0" {
			t.Fatalf("check %d = %+v, %v; want 0.7.0", i+1, rel, err)
		}
	}
	if got := gh.header(1).Get("If-None-Match"); got != `"v7"` {
		t.Fatalf("second check sent If-None-Match %q, want the first response's ETag", got)
	}
}

func TestGitHubReleasesReportsAPIErrors(t *testing.T) {
	gh := newFakeGitHub(t)
	gh.handle(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"API rate limit exceeded for 203.0.113.7."}`, http.StatusForbidden)
	})
	if _, err := gh.source().Check(context.Background(), macOS); err == nil || !strings.Contains(err.Error(), "rate limit") {
		t.Fatalf("Check error = %v, want the API's rate-limit message", err)
	}
}

func TestGitHubReleasesDownloadsWithProgress(t *testing.T) {
	gh := newFakeGitHub(t)
	payload := bytes.Repeat([]byte("companion"), 20000) // several 64 KiB reads
	zip := gh.zip("Companion-0.7.0-macos-universal.zip", payload)
	gh.serve(release("v0.7.0", zip))
	source := gh.source()
	var hooked int64
	source.progress = func(written, total int64) { hooked = written }
	rel, err := source.Check(context.Background(), macOS)
	if err != nil || rel == nil {
		t.Fatalf("Check = %+v, %v", rel, err)
	}

	var got bytes.Buffer
	var lastWritten, lastTotal int64
	err = source.Download(context.Background(), rel, &got, func(written, total int64) { lastWritten, lastTotal = written, total })
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Bytes(), payload) {
		t.Fatalf("downloaded %d bytes that differ from the %d-byte asset", got.Len(), len(payload))
	}
	n := int64(len(payload))
	if lastWritten != n || lastTotal != n || hooked != n {
		t.Fatalf("final progress = %d/%d (hook %d), want %d/%d", lastWritten, lastTotal, hooked, n, n)
	}
}

func TestGitHubReleasesDownloadRejectsShortBody(t *testing.T) {
	gh := newFakeGitHub(t)
	source := gh.source()
	asset := gh.zip("short.zip", []byte("half"))
	rel := &updater.Release{
		Artifact: updater.Artifact{Filename: asset.Name, Size: 8},
		Metadata: map[string]any{metaDownloadURL: asset.BrowserDownloadURL},
	}
	err := source.Download(context.Background(), rel, &bytes.Buffer{}, func(int64, int64) {})
	if err == nil || !strings.Contains(err.Error(), "got 4 of 8 bytes") {
		t.Fatalf("Download error = %v, want a short-read error", err)
	}
}

func TestGitHubReleasesDownloadGivesUpWhenStalled(t *testing.T) {
	unblock := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		w.Write([]byte("some bytes, then nothing"))
		w.(http.Flusher).Flush()
		select {
		case <-unblock:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(unblock) })

	source := newGitHubReleases(srv.URL, testRepo, updateAssetSuffix, "0.6.1")
	source.stallTimeout = 100 * time.Millisecond
	rel := &updater.Release{
		Artifact: updater.Artifact{Size: 1000},
		Metadata: map[string]any{metaDownloadURL: srv.URL + "/stalls.zip"},
	}
	err := source.Download(context.Background(), rel, &bytes.Buffer{}, func(int64, int64) {})
	if err == nil || !strings.Contains(err.Error(), "stalled") {
		t.Fatalf("Download error = %v, want a stall error", err)
	}
}

// --- the forced-update flow ---

type fakeEngine struct {
	mu                               sync.Mutex
	rel                              *updater.Release
	checkErr, installErr, restartErr error
	staged                           string
	gate                             chan struct{} // Check blocks on it when set
	checks, installs, restarts       int
}

func (f *fakeEngine) Check(context.Context) (*updater.Release, error) {
	f.mu.Lock()
	f.checks++
	gate := f.gate
	f.mu.Unlock()
	if gate != nil {
		<-gate
	}
	return f.rel, f.checkErr
}

func (f *fakeEngine) DownloadAndInstall(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.installs++
	return f.installErr
}

func (f *fakeEngine) DownloadedPath() string { return f.staged }

func (f *fakeEngine) Restart(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarts++
	return f.restartErr
}

func newRelease070() *updater.Release {
	return &updater.Release{
		Version:  "0.7.0",
		Artifact: updater.Artifact{Filename: "Companion-0.7.0-macos-universal.zip", Size: 1000},
		Metadata: map[string]any{metaReleaseURL: "https://github.com/" + testRepo + "/releases/tag/v0.7.0"},
	}
}

// testUpdateService returns a service running 0.6.1 from /Applications/Companion.app whose
// bundle checks pass, recording every state it emits.
func testUpdateService(eng *fakeEngine) (*updateService, *[]updateState) {
	s := newUpdateService("0.6.1", "/Applications/Companion.app")
	s.engine = eng
	s.grace = 0
	s.replaceable = func(string) error { return nil }
	s.verify = func(string, string) error { return nil }
	var states []updateState
	s.emit = func(st updateState) { states = append(states, st) }
	return s, &states
}

func phases(states []updateState) []updatePhase {
	var out []updatePhase
	for _, st := range states {
		out = append(out, st.Phase)
	}
	return out
}

// stagedUpdate makes an unpacked bundle inside a wails-update-* dir, as the Wails updater does.
func stagedUpdate(t *testing.T) string {
	staged := filepath.Join(t.TempDir(), "wails-update-123", "Companion.app")
	if err := os.MkdirAll(staged, 0o755); err != nil {
		t.Fatal(err)
	}
	return staged
}

func TestUpdateRunInstallsAndRestarts(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070(), staged: stagedUpdate(t)}
	s, states := testUpdateService(eng)
	var verified []string
	s.verify = func(staged, want string) error {
		verified = append(verified, staged, want)
		return nil
	}

	s.run(context.Background(), false)

	want := []updatePhase{updateDownloading, updateInstalling, updateRestarting}
	if got := phases(*states); !reflect.DeepEqual(got, want) {
		t.Fatalf("phases = %v, want %v", got, want)
	}
	if eng.restarts != 1 {
		t.Fatalf("Restart called %d times, want 1", eng.restarts)
	}
	if !reflect.DeepEqual(verified, []string{eng.staged, "0.7.0"}) {
		t.Fatalf("verified %v, want the staged bundle at 0.7.0", verified)
	}
	for _, st := range *states {
		if st.Current != "0.6.1" {
			t.Fatalf("state %+v doesn't carry the running version", st)
		}
	}
}

func TestUpdateRunStaysQuietWhenTheCheckFails(t *testing.T) {
	eng := &fakeEngine{checkErr: errors.New("dial tcp: no route to host")}
	s, states := testUpdateService(eng)
	s.notify = func(title, message string) { t.Fatalf("notified %q for a background check", title) }
	earlier := updateState{Phase: updateFailed, Version: "0.7.0", Error: "updater: digest mismatch"}
	s.set(earlier)

	s.run(context.Background(), false)

	if len(*states) != 1 {
		t.Fatalf("emitted %v after a failed check, want nothing", phases((*states)[1:]))
	}
	if got := s.snapshot(); got.Phase != updateFailed || got.Error != earlier.Error {
		t.Fatalf("state = %+v, want the earlier failure kept", got)
	}
	if eng.installs != 0 {
		t.Fatal("downloaded after a failed check")
	}
}

func TestUpdateRunShowsAManualCheckItsResult(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070()}
	s, _ := testUpdateService(eng)
	s.replaceable = func(string) error { return errors.New("no write access to /Applications") }
	revealed := false
	s.reveal = func() { revealed = true }

	s.run(context.Background(), true)

	if !revealed {
		t.Fatal("a manual check that found an update didn't bring the window forward")
	}
}

func TestUpdateRunAnswersAManualCheck(t *testing.T) {
	cases := []struct {
		name      string
		eng       *fakeEngine
		wantTitle string
	}{
		{"up to date", &fakeEngine{}, "You’re up to date"},
		{"check failed", &fakeEngine{checkErr: errors.New("offline")}, "Couldn’t check for updates"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _ := testUpdateService(c.eng)
			var title string
			s.notify = func(got, _ string) { title = got }
			s.run(context.Background(), true)
			if title != c.wantTitle {
				t.Fatalf("notified %q, want %q", title, c.wantTitle)
			}
		})
	}
}

func TestUpdateRunAsksForAManualUpdateWhenTheBundleCantBeReplaced(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070()}
	s, states := testUpdateService(eng)
	s.replaceable = func(string) error { return errors.New("no write access to /Applications") }

	s.run(context.Background(), false)

	last := (*states)[len(*states)-1]
	if last.Phase != updateFailed || !last.Manual || last.Version != "0.7.0" || last.ReleaseURL == "" {
		t.Fatalf("final state = %+v, want a manual-update failure for 0.7.0 with the release URL", last)
	}
	if eng.installs != 0 {
		t.Fatal("downloaded an update it can't install")
	}
}

func TestUpdateRunDoesNotRestartIntoAnUnverifiedBundle(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070(), staged: stagedUpdate(t)}
	s, states := testUpdateService(eng)
	s.verify = func(string, string) error { return errors.New("the downloaded app failed its signature check") }

	s.run(context.Background(), false)

	last := (*states)[len(*states)-1]
	if last.Phase != updateFailed || last.Manual || !strings.Contains(last.Error, "signature") {
		t.Fatalf("final state = %+v, want a signature failure", last)
	}
	if eng.restarts != 0 {
		t.Fatal("restarted into a bundle that failed verification")
	}
	if _, err := os.Stat(filepath.Dir(eng.staged)); !os.IsNotExist(err) {
		t.Fatalf("staging dir still there (err=%v), want it discarded", err)
	}
}

func TestUpdateRunReportsADownloadFailure(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070(), installErr: errors.New("updater: digest mismatch")}
	s, states := testUpdateService(eng)

	s.run(context.Background(), false)

	last := (*states)[len(*states)-1]
	if last.Phase != updateFailed || last.Error != "updater: digest mismatch" {
		t.Fatalf("final state = %+v, want the install error", last)
	}
	if eng.restarts != 0 {
		t.Fatal("restarted after a failed install")
	}
}

func TestUpdateRunKeepsTheWindowHiddenAcrossTheRestart(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "relaunch-hidden")
	eng := &fakeEngine{rel: newRelease070(), staged: stagedUpdate(t)}
	s, _ := testUpdateService(eng)
	s.markerPath = marker
	s.windowHidden = func() bool { return true }

	s.run(context.Background(), false)

	if !consumeRelaunchMarker(marker) {
		t.Fatal("no fresh relaunch marker after restarting with the window hidden")
	}
}

func TestUpdateRunClearsTheRelaunchMarkerWhenTheRestartFails(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "relaunch-hidden")
	eng := &fakeEngine{rel: newRelease070(), staged: stagedUpdate(t), restartErr: errors.New("spawn helper: permission denied")}
	s, states := testUpdateService(eng)
	s.markerPath = marker
	s.windowHidden = func() bool { return true }

	s.run(context.Background(), false)

	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("relaunch marker left behind after a failed restart (err=%v)", err)
	}
	if last := (*states)[len(*states)-1]; last.Phase != updateFailed {
		t.Fatalf("final state = %+v, want failed", last)
	}
}

func TestUpdateRunIsSingleFlight(t *testing.T) {
	eng := &fakeEngine{gate: make(chan struct{})}
	s, _ := testUpdateService(eng)
	done := make(chan struct{})
	go func() {
		s.run(context.Background(), false)
		close(done)
	}()
	for !s.running.Load() {
		time.Sleep(time.Millisecond)
	}
	s.run(context.Background(), false) // overlaps the first: returns without checking
	close(eng.gate)
	<-done
	if eng.checks != 1 {
		t.Fatalf("Check ran %d times, want 1", eng.checks)
	}
}

func TestUpdateProgressFinishesDownloading(t *testing.T) {
	s, states := testUpdateService(&fakeEngine{})
	s.set(updateState{Phase: updateDownloading, Version: "0.7.0", Total: 100})

	s.onProgress(40, 100) // within the throttle window of set(): recorded, not emitted
	if st := s.snapshot(); st.Written != 40 || st.Phase != updateDownloading {
		t.Fatalf("after 40/100: %+v", st)
	}
	s.onProgress(100, 100)
	want := []updatePhase{updateDownloading, updateInstalling}
	if got := phases(*states); !reflect.DeepEqual(got, want) {
		t.Fatalf("phases = %v, want %v", got, want)
	}
}

func TestConsumeRelaunchMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relaunch-hidden")
	if consumeRelaunchMarker(path) {
		t.Fatal("no marker, yet asked to start hidden")
	}
	os.WriteFile(path, nil, 0o600)
	if !consumeRelaunchMarker(path) {
		t.Fatal("fresh marker ignored")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("marker not removed")
	}
	os.WriteFile(path, nil, 0o600)
	old := time.Now().Add(-time.Hour)
	os.Chtimes(path, old, old)
	if consumeRelaunchMarker(path) {
		t.Fatal("stale marker honoured")
	}
}

func TestUpdateStateEndpoint(t *testing.T) {
	s := newUpdateService("0.6.1", "")
	rec := httptest.NewRecorder()
	s.handleState(rec, httptest.NewRequest(http.MethodGet, "/update", nil))
	var st updateState
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st.Phase != updateIdle || st.Current != "0.6.1" {
		t.Fatalf("GET /update = %+v, want idle at 0.6.1", st)
	}
	rec = httptest.NewRecorder()
	s.handleState(rec, httptest.NewRequest(http.MethodPost, "/update", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /update = %d, want 405", rec.Code)
	}
}

func TestUpdateServiceEnabledOnlyForBundledReleaseBuilds(t *testing.T) {
	if newUpdateService("", "/Applications/Companion.app").enabled() {
		t.Error("a dev build (no version) would self-update")
	}
	if newUpdateService("0.6.1", "").enabled() {
		t.Error("a binary outside an .app bundle would self-update")
	}
	if !newUpdateService("0.6.1", "/Applications/Companion.app").enabled() {
		t.Error("a bundled release build wouldn't self-update")
	}
}
