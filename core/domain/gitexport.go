package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// GitExport is a scheduled export to a Git repository as it syncs between devices (core/export,
// migration 0029). It is the travelling part of an export destination: which repository, how to
// sign in to it, how often — set up once, available everywhere. How a device's runs went, and
// what it has already pushed, stay on that device.
//
// Name, Config, CredentialEnc and DeviceName are protected fields (core/crypto/rows.go): with
// end-to-end encryption they cross the wire as enc$v1$ envelopes and the sync server, which
// stores the row as an opaque body, can read none of them.
type GitExport struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Config is the repository and how to reach it: provider, auth kind, remote URL, branch,
	// username, commit author, and — for SSH — the public key and the pinned host key.
	Config json.RawMessage `json:"config"`
	// CredentialEnc is the access token, the password, or the SSH private key. Plaintext locally
	// and an envelope on the wire, like CalendarAccount.CredentialEnc; nil when end-to-end
	// encryption is off, in which case the credential never leaves the device it was typed into.
	CredentialEnc *string `json:"credentialEnc,omitempty"`
	Schedule      string  `json:"schedule"`
	Enabled       bool    `json:"enabled"`
	// DeviceID is the one device that runs this export; DeviceName is what the others call it.
	DeviceID   string     `json:"deviceId"`
	DeviceName string     `json:"deviceName"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	DeletedAt  *time.Time `json:"deletedAt,omitempty"`
	Version    int64      `json:"version"`
	Dirty      bool       `json:"dirty"`
}

func (g *GitExport) SyncID() string           { return g.ID }
func (g *GitExport) SyncVersion() int64       { return g.Version }
func (g *GitExport) SyncUpdatedAt() time.Time { return g.UpdatedAt }
func (g *GitExport) SyncDeleted() bool        { return g.DeletedAt != nil }
func (g *GitExport) SyncDirty() bool          { return g.Dirty }

// ErrInvalidGitExport is returned when a pulled row can't be a Git export.
var ErrInvalidGitExport = errors.New("invalid git export")

func (g *GitExport) Validate() error {
	if strings.TrimSpace(g.ID) == "" {
		return errors.Join(ErrInvalidGitExport, errors.New("id is required"))
	}
	return nil
}
