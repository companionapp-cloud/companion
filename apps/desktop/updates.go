package main

// Forced in-app updates (macOS release builds).
//
// Release builds are stamped with their version (the release workflow passes
// -ldflags "-X main.version=<tag>"); dev builds leave it empty and never update. On launch,
// hourly and on wake, Companion asks GitHub for the latest stable release. A newer one is mandatory:
// the webview blocks the window behind an "Updating Companion" screen
// (frontend/src/updates.tsx) while the Wails v3 updater downloads the universal zip, checks it
// against the sha256 GitHub recorded for the asset, and unpacks it. We then confirm the
// unpacked bundle is a sealed com.companion.desktop at the expected version, and the updater's
// helper (this same binary, see updater.HandleHelperMode in main) swaps it into place once we
// quit and relaunches it.
//
// No quarantine is involved: only quarantine-aware downloaders (browsers, Homebrew) set
// com.apple.quarantine, and Go's HTTP client and zip reader don't, so the new bundle opens the
// same way the brew-installed one does after the cask's postflight strips it.
//
// A check that fails (offline, rate-limited) never blocks: Companion is local-first, so it
// opens normally and tries again on the next check. A failed download or install shows a
// dismissible notice and is retried the same way.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/updater"
)

const (
	updateRepo = "companionapp-cloud/companion"
	// updateAssetSuffix names the release asset to install, Companion-<version>-macos-universal.zip.
	// Matched by name: the Wails github provider's default "contains darwin and the arch"
	// heuristic would pick companion-server-darwin-arm64 from the same release.
	updateAssetSuffix = "-macos-universal.zip"
	updateBundleID    = "com.companion.desktop"

	updateCheckInterval = time.Hour
	wakeCheckDelay      = 30 * time.Second
	updateCheckTimeout  = 30 * time.Second
	updateTotalTimeout  = 20 * time.Minute
	// downloadStallTimeout gives up on a download that stops delivering bytes, so a dead
	// connection can't hold the blocking update screen up; the next check retries.
	downloadStallTimeout = time.Minute
	// restartGrace keeps "Restarting…" on screen long enough for the webview's debounced saves
	// (400ms in NotesProvider/TaskEditor) to reach the store before the process quits.
	restartGrace = 1500 * time.Millisecond
	// relaunchMarkerMaxAge bounds how long after an update restart the relaunch marker is
	// honoured; an older one means the restart never happened and the user opened the app later.
	relaunchMarkerMaxAge = 2 * time.Minute

	// updateStateEvent carries updateState to the webview (Wails event, all windows).
	updateStateEvent = "update:state"

	metaDownloadURL = "companion.downloadURL"
	metaReleaseURL  = "companion.releaseURL"
)

type updatePhase string

const (
	updateIdle        updatePhase = "idle"
	updateDownloading updatePhase = "downloading"
	updateInstalling  updatePhase = "installing" // digest check, unpack, bundle verification
	updateRestarting  updatePhase = "restarting"
	updateFailed      updatePhase = "failed"
)

// updateState is what GET /update returns and the "update:state" event carries. The webview
// blocks the window while the phase is downloading, installing or restarting, and shows a
// dismissible notice while it's failed.
type updateState struct {
	Phase   updatePhase `json:"phase"`
	Current string      `json:"current,omitempty"`
	// Version is the release being installed, or the one that failed to install.
	Version string `json:"version,omitempty"`
	Written int64  `json:"written,omitempty"`
	Total   int64  `json:"total,omitempty"`
	Error   string `json:"error,omitempty"`
	// Manual: this copy of the app can't be replaced in place, so the update has to be done by
	// hand (Homebrew or a fresh download from ReleaseURL).
	Manual     bool   `json:"manual,omitempty"`
	ReleaseURL string `json:"releaseUrl,omitempty"`
}

// updateEngine is the part of the Wails updater (app.Updater) the flow drives. Tests fake it.
type updateEngine interface {
	Check(ctx context.Context) (*updater.Release, error)
	DownloadAndInstall(ctx context.Context) error
	DownloadedPath() string
	Restart(ctx context.Context) error
}

// updateService runs the forced-update flow and reports its state to the webview.
type updateService struct {
	current string // running version, "" in dev builds
	bundle  string // the running .app bundle the update replaces, "" when not in one

	engine updateEngine
	emit   func(updateState)
	// notify answers a check the user asked for (tray › Check for Updates…) with a dialog.
	notify func(title, message string)
	// reveal brings the main window forward when a check the user asked for starts an install,
	// so they can watch it.
	reveal func()
	// windowHidden reports whether the main window is closed to the menu bar; the relaunched
	// version then starts hidden too (see markerPath).
	windowHidden func() bool
	markerPath   string

	// Checks against the real bundle, swapped out in tests.
	replaceable func(bundle string) error
	verify      func(staged, wantVersion string) error
	grace       time.Duration

	running atomic.Bool

	mu           sync.Mutex
	state        updateState
	lastProgress time.Time
}

// newUpdateService returns the service for this build. It is inert (enabled reports false)
// in dev builds, off macOS, and outside an .app bundle; GET /update still answers "idle".
func newUpdateService(current, bundle string) *updateService {
	return &updateService{
		current:     current,
		bundle:      bundle,
		emit:        func(updateState) {},
		replaceable: replaceableBundle,
		verify:      verifyStagedBundle,
		grace:       restartGrace,
		state:       updateState{Phase: updateIdle, Current: current},
	}
}

func (s *updateService) enabled() bool { return s.current != "" && s.bundle != "" }

// attach wires the service to the running app: the Wails updater (fed by the GitHub release
// source) as its engine, Wails events to reach every window, native dialogs and the main
// window for check-for-updates, and the check loop once the app has started.
func (s *updateService) attach(app *application.App, mainWindow *application.WebviewWindow) error {
	source := newGitHubReleases("https://api.github.com", updateRepo, updateAssetSuffix, s.current)
	source.progress = s.onProgress
	if err := app.Updater.Init(updater.Config{
		CurrentVersion: s.current,
		Providers:      []updater.Provider{source},
		// Headless: the update screen is ours (frontend/src/updates.tsx), driven by updateState.
		Window: updater.WindowNone,
	}); err != nil {
		return err
	}
	s.engine = app.Updater
	s.emit = func(st updateState) { app.Event.Emit(updateStateEvent, st) }
	s.notify = func(title, message string) {
		app.Dialog.Info().SetTitle(title).SetMessage(message).Show()
	}
	s.reveal = func() {
		mainWindow.Show()
		mainWindow.Focus()
	}
	s.windowHidden = func() bool { return !mainWindow.IsVisible() }
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go s.loop(context.Background())
	})
	// The hourly ticker doesn't count time asleep, so a laptop that stays asleep overnight
	// would otherwise wait up to an hour after waking. Give the network a moment to come back.
	app.Event.OnApplicationEvent(events.Common.SystemDidWake, func(*application.ApplicationEvent) {
		time.AfterFunc(wakeCheckDelay, func() { s.run(context.Background(), false) })
	})
	return nil
}

// loop checks now and then every updateCheckInterval until ctx ends (or an update restarts the app).
func (s *updateService) loop(ctx context.Context) {
	t := time.NewTicker(updateCheckInterval)
	defer t.Stop()
	for {
		s.run(ctx, false)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// checkNow runs a check the user asked for; the result is reported in a dialog.
func (s *updateService) checkNow() {
	go s.run(context.Background(), true)
}

// run checks for an update and, when there is one, installs it and restarts into it. Only one
// run happens at a time; a call that overlaps a running one returns immediately.
func (s *updateService) run(ctx context.Context, manual bool) {
	if s.engine == nil || !s.running.CompareAndSwap(false, true) {
		return
	}
	defer s.running.Store(false)

	// Checking isn't a state the webview sees, and neither is a failed check: offline,
	// rate-limited or GitHub down, Companion (local-first) just carries on, and a notice about
	// an earlier failed install stays up.
	checkCtx, cancel := context.WithTimeout(ctx, updateCheckTimeout)
	rel, err := s.engine.Check(checkCtx)
	cancel()
	if err != nil {
		log.Printf("update: check failed: %v", err)
		if manual {
			s.tell("Couldn’t check for updates", err.Error())
		}
		return
	}
	if rel == nil {
		s.set(updateState{Phase: updateIdle})
		if manual {
			s.tell("You’re up to date", fmt.Sprintf("Companion %s is the latest version.", s.current))
		}
		return
	}

	releaseURL, _ := rel.Metadata[metaReleaseURL].(string)
	fail := func(err error, manualUpdate bool) {
		log.Printf("update: installing %s failed: %v", rel.Version, err)
		s.set(updateState{Phase: updateFailed, Version: rel.Version, Error: err.Error(), Manual: manualUpdate, ReleaseURL: releaseURL})
	}
	log.Printf("update: %s is available (running %s)", rel.Version, s.current)
	// Someone who asked sees how it goes, even if the window was closed to the menu bar.
	if manual && s.reveal != nil {
		s.reveal()
	}

	// Find out before downloading whether the swap could work at all.
	if err := s.replaceable(s.bundle); err != nil {
		fail(err, true)
		return
	}

	s.set(updateState{Phase: updateDownloading, Version: rel.Version, Total: rel.Artifact.Size})
	installCtx, cancel := context.WithTimeout(ctx, updateTotalTimeout)
	defer cancel()
	if err := s.engine.DownloadAndInstall(installCtx); err != nil {
		fail(err, false)
		return
	}
	s.set(updateState{Phase: updateInstalling, Version: rel.Version})
	staged := s.engine.DownloadedPath()
	if err := s.verify(staged, rel.Version); err != nil {
		discardStaged(staged)
		fail(err, false)
		return
	}

	s.set(updateState{Phase: updateRestarting, Version: rel.Version})
	marked := s.markRelaunchHidden()
	select {
	case <-time.After(s.grace):
	case <-ctx.Done():
	}
	log.Printf("update: restarting into %s", rel.Version)
	if err := s.engine.Restart(installCtx); err != nil {
		if marked {
			_ = os.Remove(s.markerPath)
		}
		discardStaged(staged)
		fail(err, false)
	}
}

// onProgress receives download progress from the release source. It throttles updates to the
// webview to ~10/s and switches to "installing" once every byte has arrived.
func (s *updateService) onProgress(written, total int64) {
	s.mu.Lock()
	if s.state.Phase != updateDownloading {
		s.mu.Unlock()
		return
	}
	s.state.Written, s.state.Total = written, total
	done := total > 0 && written >= total
	if done {
		s.state.Phase = updateInstalling
	}
	if !done && time.Since(s.lastProgress) < 100*time.Millisecond {
		s.mu.Unlock()
		return
	}
	s.lastProgress = time.Now()
	st := s.state
	s.mu.Unlock()
	s.emit(st)
}

func (s *updateService) set(st updateState) {
	st.Current = s.current
	s.mu.Lock()
	s.state = st
	s.lastProgress = time.Now()
	s.mu.Unlock()
	s.emit(st)
}

func (s *updateService) snapshot() updateState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *updateService) tell(title, message string) {
	if s.notify != nil {
		s.notify(title, message)
	}
}

// markRelaunchHidden leaves the relaunch marker when the main window is closed to the menu
// bar, so the restarted version doesn't pop its window open. Reports whether it wrote one.
func (s *updateService) markRelaunchHidden() bool {
	if s.markerPath == "" || s.windowHidden == nil || !s.windowHidden() {
		return false
	}
	return os.WriteFile(s.markerPath, []byte(time.Now().UTC().Format(time.RFC3339)), 0o600) == nil
}

// consumeRelaunchMarker reports whether this launch is an update restart that should keep the
// main window hidden, removing the marker either way.
func consumeRelaunchMarker(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	_ = os.Remove(path)
	return time.Since(info.ModTime()) < relaunchMarkerMaxAge
}

// relaunchMarkerPath keeps the marker beside the database.
func relaunchMarkerPath(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "relaunch-hidden")
}

// discardStaged removes the updater's temp dir (wails-update-*) around an unpacked update we
// decided not to install.
func discardStaged(staged string) {
	if dir := filepath.Dir(staged); strings.HasPrefix(filepath.Base(dir), "wails-update-") {
		_ = os.RemoveAll(dir)
	}
}

// handleState serves GET /update: the current updateState, for a window that opens (or
// reloads) mid-update and missed the events.
func (s *updateService) handleState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.snapshot())
}

// githubReleases is the update source (an updater.Provider): the repo's latest published
// GitHub release. Compared with the Wails github provider it picks our asset by name, verifies
// against the sha256 digest GitHub records for every uploaded asset (no checksum file to
// publish, and it fails closed without one), treats a release whose macOS zip hasn't been
// uploaded yet as "nothing new", and revalidates with an ETag so the hourly check rarely spends
// the unauthenticated API quota (60 requests/hour per IP).
type githubReleases struct {
	api, repo, suffix string
	userAgent         string
	client            *http.Client
	stallTimeout      time.Duration
	// progress, when set, also receives download progress (the update screen's bar).
	progress func(written, total int64)

	mu     sync.Mutex
	etag   string
	cached *ghRelease
}

type ghRelease struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	HTMLURL     string    `json:"html_url"`
	PublishedAt time.Time `json:"published_at"`
	Assets      []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	// Digest is "sha256:<hex>", computed by GitHub when the asset was uploaded.
	Digest             string `json:"digest"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

func newGitHubReleases(api, repo, suffix, current string) *githubReleases {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	return &githubReleases{
		api:          strings.TrimRight(api, "/"),
		repo:         repo,
		suffix:       suffix,
		userAgent:    "Companion/" + current,
		client:       &http.Client{Transport: transport},
		stallTimeout: downloadStallTimeout,
	}
}

func (p *githubReleases) Name() string { return "github" }

// Check implements updater.Provider.
func (p *githubReleases) Check(ctx context.Context, req updater.CheckRequest) (*updater.Release, error) {
	rel, err := p.latest(ctx)
	if err != nil || rel == nil {
		return nil, err
	}
	v := strings.TrimPrefix(rel.TagName, "v")
	// Only stable releases go to everyone. /releases/latest already skips drafts and releases
	// marked prerelease; a -rc1 tag is skipped too in case one is published unmarked.
	if rel.Draft || rel.Prerelease || strings.Contains(v, "-") {
		return nil, nil
	}
	newer, err := versionNewer(v, req.CurrentVersion)
	if err != nil {
		return nil, err
	}
	if !newer {
		return nil, nil
	}
	var asset *ghAsset
	for i := range rel.Assets {
		if strings.HasSuffix(rel.Assets[i].Name, p.suffix) {
			asset = &rel.Assets[i]
			break
		}
	}
	if asset == nil {
		// The release exists as soon as the first release job attaches its files; the macOS
		// zip follows a few minutes later. Not an error — the next check will find it.
		log.Printf("update: release %s has no *%s yet", rel.TagName, p.suffix)
		return nil, nil
	}
	digest, err := parseSHA256Digest(asset.Digest)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", asset.Name, err)
	}
	return &updater.Release{
		Version:     v,
		Name:        rel.Name,
		Notes:       rel.Body,
		PublishedAt: rel.PublishedAt,
		Artifact: updater.Artifact{
			Filename: asset.Name,
			Filetype: "zip",
			Size:     asset.Size,
			Platform: req.Platform,
			Arch:     req.Arch,
		},
		Verification: &updater.Verification{DigestAlgo: "sha256", Digest: digest},
		Metadata: map[string]any{
			metaDownloadURL: asset.BrowserDownloadURL,
			metaReleaseURL:  rel.HTMLURL,
		},
	}, nil
}

// latest fetches /releases/latest, revalidating the previous answer with If-None-Match.
// Returns nil when the repo has no published release.
func (p *githubReleases) latest(ctx context.Context) (*ghRelease, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.api+"/repos/"+p.repo+"/releases/latest", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", p.userAgent)
	p.mu.Lock()
	etag, cached := p.etag, p.cached
	p.mu.Unlock()
	if etag != "" && cached != nil {
		req.Header.Set("If-None-Match", etag)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotModified:
		if cached == nil {
			return nil, errors.New("github: 304 Not Modified without a cached release")
		}
		return cached, nil
	case http.StatusNotFound:
		return nil, nil
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("github: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var rel ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("github: decode release: %w", err)
	}
	p.mu.Lock()
	p.etag, p.cached = resp.Header.Get("ETag"), &rel
	p.mu.Unlock()
	return &rel, nil
}

// Download implements updater.Provider: it streams the asset to dst, reporting progress.
func (p *githubReleases) Download(ctx context.Context, rel *updater.Release, dst io.Writer, onProgress func(written, total int64)) error {
	url, _ := rel.Metadata[metaDownloadURL].(string)
	if url == "" {
		return errors.New("github: release has no download URL")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stalled := atomic.Bool{}
	watchdog := time.AfterFunc(p.stallTimeout, func() {
		stalled.Store(true)
		cancel()
	})
	defer watchdog.Stop()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", p.userAgent)
	resp, err := p.client.Do(req)
	if err != nil {
		return p.downloadErr(err, &stalled)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("github: download: %s", resp.Status)
	}

	total := rel.Artifact.Size
	if total <= 0 {
		total = resp.ContentLength
	}
	var written int64
	buf := make([]byte, 64<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			watchdog.Reset(p.stallTimeout)
			if _, err := dst.Write(buf[:n]); err != nil {
				return err
			}
			written += int64(n)
			onProgress(written, total)
			if p.progress != nil {
				p.progress(written, total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return p.downloadErr(rerr, &stalled)
		}
	}
	if total > 0 && written != total {
		return fmt.Errorf("github: download: got %d of %d bytes", written, total)
	}
	return nil
}

func (p *githubReleases) downloadErr(err error, stalled *atomic.Bool) error {
	if stalled.Load() {
		return fmt.Errorf("github: download stalled (no data for %s)", p.stallTimeout)
	}
	return fmt.Errorf("github: download: %w", err)
}

// parseSHA256Digest decodes a GitHub asset digest ("sha256:<64 hex>").
func parseSHA256Digest(s string) ([]byte, error) {
	hexDigest, ok := strings.CutPrefix(s, "sha256:")
	if !ok {
		return nil, errors.New("release asset has no sha256 digest to verify against")
	}
	digest, err := hex.DecodeString(hexDigest)
	if err != nil || len(digest) != 32 {
		return nil, fmt.Errorf("release asset has a malformed sha256 digest %q", s)
	}
	return digest, nil
}

// versionNewer reports whether version a is later than b ("1.10.0" is later than "1.9.2").
// Versions are dotted numbers with an optional -prerelease suffix, which sorts before the
// release it precedes ("0.7.0" is later than "0.7.0-rc1"); a leading "v" and +build metadata
// are ignored.
func versionNewer(a, b string) (bool, error) {
	va, err := parseVersion(a)
	if err != nil {
		return false, err
	}
	vb, err := parseVersion(b)
	if err != nil {
		return false, err
	}
	for i := range va.nums {
		if va.nums[i] != vb.nums[i] {
			return va.nums[i] > vb.nums[i], nil
		}
	}
	switch {
	case va.pre == vb.pre:
		return false, nil
	case va.pre == "":
		return true, nil
	case vb.pre == "":
		return false, nil
	default:
		return va.pre > vb.pre, nil
	}
}

type semver struct {
	nums [3]int
	pre  string
}

func parseVersion(s string) (semver, error) {
	var v semver
	core := strings.TrimPrefix(strings.TrimSpace(s), "v")
	core, _, _ = strings.Cut(core, "+")
	core, v.pre, _ = strings.Cut(core, "-")
	parts := strings.Split(core, ".")
	if core == "" || len(parts) > 3 {
		return v, fmt.Errorf("invalid version %q", s)
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return v, fmt.Errorf("invalid version %q", s)
		}
		v.nums[i] = n
	}
	return v, nil
}
