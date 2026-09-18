//go:build !js

// Package agentrt is the desktop-side implementation of local AI agents (PLAN-agents.md §3,
// §4): discovering the tools installed on this machine and driving the CLI ones as child
// processes. It is injected into the bridge by the desktop shell; the web build never links
// it (os/exec is meaningless under GOOS=js) and mobile shells simply don't inject it.
package agentrt

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"companion/core/agents"
)

// Runtime ids, mirrored from core/domain to avoid an import cycle through the bridge.
const (
	runtimeClaudeCLI = "claude-cli"
	runtimeCodexCLI  = "codex-cli"
	runtimeOllama    = "ollama"
	runtimeLMStudio  = "lmstudio"
)

// Default local endpoints probed during discovery.
const (
	ollamaBaseURL   = "http://127.0.0.1:11434"
	lmstudioBaseURL = "http://127.0.0.1:1234"
)

// probeTimeout bounds each individual probe (a version exec or a localhost GET), and
// discoverBudget bounds the whole scan so the Add Agent screen never hangs.
const (
	probeTimeout   = 1500 * time.Millisecond
	discoverBudget = 4 * time.Second
)

// Discoverer scans PATH, the well-known install dirs a GUI app's PATH misses, and the local
// HTTP ports of Ollama and LM Studio. It is stateless; results are never persisted.
type Discoverer struct {
	// LookupDirs overrides the extra directories searched (tests point this at a temp dir).
	LookupDirs []string
	// OllamaURL / LMStudioURL override the probed endpoints (tests use httptest servers).
	OllamaURL, LMStudioURL string
	// UseLoginShell asks the user's login shell for the binary as a last resort, which picks up
	// nvm/volta style PATH setups. Off in tests.
	UseLoginShell bool
	// HTTP is the client for local probes; nil uses a short-timeout default.
	HTTP *http.Client
}

// NewDiscoverer returns a discoverer with the platform's default search dirs and endpoints.
func NewDiscoverer() *Discoverer {
	return &Discoverer{LookupDirs: defaultLookupDirs(), OllamaURL: ollamaBaseURL, LMStudioURL: lmstudioBaseURL, UseLoginShell: true}
}

func (d *Discoverer) http() *http.Client {
	if d.HTTP != nil {
		return d.HTTP
	}
	return &http.Client{Timeout: probeTimeout}
}

// Discover runs every probe in parallel under one budget and returns the tools found, sorted
// by runtime for stable rendering.
func (d *Discoverer) Discover(ctx context.Context) ([]agents.Discovered, error) {
	ctx, cancel := context.WithTimeout(ctx, discoverBudget)
	defer cancel()

	var (
		mu  sync.Mutex
		out []agents.Discovered
		wg  sync.WaitGroup
	)
	add := func(found *agents.Discovered) {
		if found == nil {
			return
		}
		mu.Lock()
		out = append(out, *found)
		mu.Unlock()
	}
	probes := []func(context.Context) *agents.Discovered{d.probeClaude, d.probeCodex, d.probeOllama, d.probeLMStudio}
	for _, p := range probes {
		wg.Add(1)
		go func(p func(context.Context) *agents.Discovered) {
			defer wg.Done()
			add(p(ctx))
		}(p)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Runtime < out[j].Runtime })
	if out == nil {
		out = []agents.Discovered{}
	}
	return out, nil
}

// --- CLI probes -------------------------------------------------------------

func (d *Discoverer) probeClaude(ctx context.Context) *agents.Discovered {
	path := d.findBinary("claude")
	if path == "" {
		return nil
	}
	version := cleanVersion(runVersion(ctx, path, "--version"), "(Claude Code)")
	return &agents.Discovered{Runtime: runtimeClaudeCLI, Name: "Claude Code", Path: path, Version: version, Status: agents.StatusReady}
}

func (d *Discoverer) probeCodex(ctx context.Context) *agents.Discovered {
	path := d.findBinary("codex")
	if path == "" {
		return nil
	}
	version := cleanVersion(runVersion(ctx, path, "--version"), "codex-cli")
	return &agents.Discovered{Runtime: runtimeCodexCLI, Name: "Codex CLI", Path: path, Version: version, Status: agents.StatusReady}
}

// findBinary resolves name on PATH, then in the extra dirs, then (optionally) via the login
// shell. The absolute path is what gets stored, so later runs don't depend on PATH at all.
func (d *Discoverer) findBinary(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		if abs, err := filepath.Abs(p); err == nil {
			return abs
		}
		return p
	}
	for _, dir := range d.LookupDirs {
		for _, cand := range expandGlob(filepath.Join(dir, name)) {
			if isExecutable(cand) {
				return cand
			}
		}
	}
	if d.UseLoginShell {
		if p := loginShellLookup(name); p != "" {
			return p
		}
	}
	return ""
}

// expandGlob returns the paths matching pattern (which may contain a * for e.g. nvm's
// per-version bin dirs), newest-sorted last so callers pick the first hit deterministically.
func expandGlob(pattern string) []string {
	if !strings.Contains(pattern, "*") {
		return []string{pattern}
	}
	matches, _ := filepath.Glob(pattern)
	sort.Sort(sort.Reverse(sort.StringSlice(matches))) // highest version first
	return matches
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}

// loginShellLookup asks the user's login shell where name lives. A GUI-launched app inherits a
// minimal PATH; the login shell has the user's real one (nvm, volta, homebrew shellenv…).
func loginShellLookup(name string) string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, shell, "-lc", "command -v "+name).Output()
	if err != nil {
		return ""
	}
	p := strings.TrimSpace(string(out))
	if p == "" || !filepath.IsAbs(p) || !isExecutable(p) {
		return ""
	}
	return p
}

// runVersion runs `path arg` and returns the first line of stdout, or "".
func runVersion(ctx context.Context, path string, arg string) string {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, arg).Output()
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(out))
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	return line
}

// cleanVersion strips a known product tag ("1.2.3 (Claude Code)" → "1.2.3").
func cleanVersion(v, tag string) string {
	v = strings.TrimSpace(strings.ReplaceAll(v, tag, ""))
	return strings.TrimSpace(v)
}

// --- HTTP probes ------------------------------------------------------------

func (d *Discoverer) probeOllama(ctx context.Context) *agents.Discovered {
	base := strings.TrimRight(d.OllamaURL, "/")
	found := &agents.Discovered{Runtime: runtimeOllama, Name: "Ollama", Path: base + "/v1", Status: agents.StatusReady}
	var ver struct {
		Version string `json:"version"`
	}
	if err := d.getJSON(ctx, base+"/api/version", &ver); err != nil {
		// Not answering: report it only if Ollama is installed, so the card can say "start it".
		if d.findBinary("ollama") == "" && !ollamaAppInstalled() {
			return nil
		}
		found.Status = agents.StatusNotRunning
		found.Detail = "Ollama is installed but not running. Start it to use it."
		return found
	}
	found.Version = ver.Version
	var tags struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := d.getJSON(ctx, base+"/api/tags", &tags); err == nil {
		for _, m := range tags.Models {
			found.Models = append(found.Models, m.Name)
		}
		sort.Strings(found.Models)
	}
	return found
}

func (d *Discoverer) probeLMStudio(ctx context.Context) *agents.Discovered {
	base := strings.TrimRight(d.LMStudioURL, "/")
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := d.getJSON(ctx, base+"/v1/models", &list); err != nil {
		return nil
	}
	found := &agents.Discovered{Runtime: runtimeLMStudio, Name: "LM Studio", Path: base + "/v1", Status: agents.StatusReady}
	for _, m := range list.Data {
		found.Models = append(found.Models, m.ID)
	}
	sort.Strings(found.Models)
	return found
}

func (d *Discoverer) getJSON(ctx context.Context, url string, v any) error {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := d.http().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return &http.ProtocolError{ErrorString: res.Status}
	}
	return json.NewDecoder(res.Body).Decode(v)
}
