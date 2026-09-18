//go:build !windows && !js

package agentrt

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the child in its own process group so a cancel kills the CLI and
// anything it spawned (a node shim, a shell command), not just the top process.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}
