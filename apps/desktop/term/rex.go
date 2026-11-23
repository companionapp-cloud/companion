package term

import (
	_ "embed"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

//go:embed rex.lua
var rexPlugin []byte

// rexMarker tags the line `companion rex install` adds to Rex's init.lua, so a reinstall
// replaces it instead of adding a second.
const rexMarker = "-- Companion (companion rex install)"

// RexInstall writes the Rex plugin and loads it from Rex's init.lua with bin as the command
// it runs. Running it again updates both in place.
func RexInstall(bin string, out io.Writer) error {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		dir = filepath.Join(home, ".config")
	}
	rexDir := filepath.Join(dir, "rex")
	initPath := os.Getenv("REX_CONFIG")
	if initPath == "" {
		initPath = filepath.Join(rexDir, "init.lua")
	}
	pluginPath := filepath.Join(rexDir, "plugins", "companion", "init.lua")
	if err := os.MkdirAll(filepath.Dir(pluginPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(pluginPath, rexPlugin, 0o644); err != nil {
		return err
	}

	line := fmt.Sprintf("dofile(%q).setup({ bin = { %q } })", pluginPath, bin)
	existing, err := os.ReadFile(initPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var kept []string
	lines := strings.Split(strings.TrimRight(string(existing), "\n"), "\n")
	for i := 0; i < len(lines); i++ {
		if lines[i] == rexMarker {
			i++ // drop the marker and the dofile line under it
			continue
		}
		kept = append(kept, lines[i])
	}
	if len(kept) == 1 && kept[0] == "" {
		kept = nil
	}
	kept = append(kept, rexMarker, line)
	if err := os.WriteFile(initPath, []byte(strings.Join(kept, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(out, "Installed the Companion plugin for Rex:\n  %s\n  loaded from %s\nRun `rex config reload`, then look for “Companion:” in Rex's palette.\n", pluginPath, initPath)
	return nil
}
