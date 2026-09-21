package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// GitExport is a scheduled export to a Git repository as it syncs between devices (core/export,
// migration 0029). It is the travelling part of an export destination: which repository, how to
// sign in to it, how often — set up once, available everywhere. What a device has already pushed
// stays on that device; how its last run went travels as ExportStatus, for the others to show.
//
// Name, Config, CredentialEnc, DeviceName and LastError are protected fields (core/crypto/rows.go):
// with end-to-end encryption they cross the wire as enc$v1$ envelopes and the sync server, which
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
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	// ChangedBy is the device that last changed the settings; a change made anywhere but on
	// DeviceID reaches the exporter only when it next syncs. Empty from clients before 0030.
	ChangedBy string `json:"changedBy,omitempty"`
	ExportStatus
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// ExportStatus is how the device that runs an export last found it, reported so the other
// devices can show whether it is working (migration 0030). Only the exporting device writes it,
// and writing it never moves the row's UpdatedAt: UpdatedAt dates the settings alone, so under
// the sync engine's last-writer-wins a pause or a takeover made on another device beats a status
// report that races it, instead of being quietly undone by it.
type ExportStatus struct {
	LastRunAt     *time.Time `json:"lastRunAt,omitempty"`
	LastSuccessAt *time.Time `json:"lastSuccessAt,omitempty"`
	LastError     string     `json:"lastError,omitempty"`
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

// FolderExport is a scheduled export to a folder as it syncs between devices (migration 0030).
// The folder is on one device's disk and only that device (DeviceID) ever writes it; the row
// travels so the others know it is there — which folder, how often, whether it is working — and
// can pause it or take it over. Nothing about what the device has written travels with it.
//
// Name, Config (the folder's path), DeviceName and LastError are protected fields.
type FolderExport struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Config   json.RawMessage `json:"config"`
	Schedule string          `json:"schedule"`
	Enabled  bool            `json:"enabled"`
	// DeviceID is the device whose disk the folder is on; DeviceName is what the others call it.
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	// ChangedBy is the device that last changed the settings (see GitExport.ChangedBy).
	ChangedBy string `json:"changedBy,omitempty"`
	ExportStatus
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

func (f *FolderExport) SyncID() string           { return f.ID }
func (f *FolderExport) SyncVersion() int64       { return f.Version }
func (f *FolderExport) SyncUpdatedAt() time.Time { return f.UpdatedAt }
func (f *FolderExport) SyncDeleted() bool        { return f.DeletedAt != nil }
func (f *FolderExport) SyncDirty() bool          { return f.Dirty }

// ErrInvalidFolderExport is returned when a pulled row can't be a folder export.
var ErrInvalidFolderExport = errors.New("invalid folder export")

func (f *FolderExport) Validate() error {
	if strings.TrimSpace(f.ID) == "" {
		return errors.Join(ErrInvalidFolderExport, errors.New("id is required"))
	}
	return nil
}
