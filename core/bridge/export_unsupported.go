//go:build js || ios || android

package bridge

import (
	"context"
	"errors"

	"companion/core/store"
)

// Scheduled exports run on the desktop only for now: a browser has no folder to write or
// schedule to keep, and the phones need platform work first (security-scoped folder bookmarks on
// iOS, a storage-access writer on Android, background pushes on both). These builds leave go-git
// out entirely; export.capabilities answers no and the settings page points at the desktop app.
const exportSupported = false

var errExportUnsupported = errors.New("scheduled exports aren't available on this device")

func splitGitCredentials(raw string) (clean, username, token string) { return raw, "", "" }

func isSSHRemote(string) bool { return false }

func generateSSHKey() ([]byte, string, error) { return nil, "", errExportUnsupported }

func sshPublicKey([]byte) (string, error) { return "", errExportUnsupported }

func checkGitRemote(context.Context, gitConfig, string) error { return errExportUnsupported }

func (c *Core) syncGit(context.Context, *store.ExportDestination, gitConfig, string, bool) (any, bool, error) {
	return nil, false, errExportUnsupported
}
