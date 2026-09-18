//go:build !js

package agentrt

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"companion/core/agents"
)

// Factory builds runners for installed CLI agents and owns their scratch directories
// (<dataDir>/agents/<agentId>/), so a write-enabled agent has somewhere harmless to write.
type Factory struct {
	DataDir string
}

// NewFactory returns a factory rooted at dataDir (the Companion config dir on desktop).
func NewFactory(dataDir string) *Factory { return &Factory{DataDir: dataDir} }

// RunnerFor returns the runner for a CLI runtime at binaryPath.
func (f *Factory) RunnerFor(runtime, binaryPath string) (agents.Runner, error) {
	if binaryPath == "" {
		return nil, fmt.Errorf("agent has no binary path; rescan and reinstall it")
	}
	if !isExecutable(binaryPath) {
		return nil, fmt.Errorf("%s is no longer at %s; rescan and reinstall it", runtime, binaryPath)
	}
	switch runtime {
	case runtimeClaudeCLI:
		return &ClaudeRunner{Path: binaryPath}, nil
	case runtimeCodexCLI:
		return &CodexRunner{Path: binaryPath}, nil
	default:
		return nil, fmt.Errorf("runtime %q is not a CLI agent", runtime)
	}
}

// WorkDir returns the per-agent scratch directory, creating it on first use.
func (f *Factory) WorkDir(agentID string) (string, error) {
	dir := filepath.Join(f.DataDir, "agents", agentID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// RunnerSettings are the runtime-specific options an agent's settingsJson may carry.
type RunnerSettings struct {
	ExtraArgs []string `json:"extraArgs,omitempty"`
}

// ParseSettings decodes an agent's settingsJson; an empty or invalid value yields defaults.
func ParseSettings(settingsJSON string) RunnerSettings {
	var s RunnerSettings
	_ = json.Unmarshal([]byte(settingsJSON), &s)
	return s
}
