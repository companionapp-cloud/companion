package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"companion/core/blob"
	"companion/core/export"
	"companion/core/store"
)

// Scheduled exports: mirroring the workspace out to a folder or a Git repository (core/export).
// The UI manages destinations through the export.* methods; a scheduler started by the shell
// (StartExportScheduler) runs them — when things change, or hourly, daily or weekly — and every
// run reports itself with an "export.changed" event so Settings › Export stays live.
//
// A folder destination is this device's alone. A Git destination syncs (domain.GitExport,
// migration 0029) — repository, schedule and credential, the credential sealed under the
// end-to-end encryption key — so it is set up once for every device; but only one device, its
// exporter (DeviceID), ever runs it. Two devices with different sync states pushing to one
// branch would fight; the others hold the settings and can take the export over in one step.
//
// Only a shell that can host exports turns the feature on, by giving it somewhere to keep its
// bare Git repositories (SetExportDir — the desktop). Everywhere else export.capabilities
// answers no and the settings page says where exports live.

const exportChangedEvent = "export.changed"

const (
	// exportQuiet is how long the workspace must sit still before an "on changes" export runs,
	// so a burst of typing is one export, not thirty.
	exportQuiet = 45 * time.Second
	// exportRetry is how long a failed run — or a commit still waiting to be pushed — waits
	// before it's tried again.
	exportRetry = 10 * time.Minute
	exportTick  = 15 * time.Second
	// gitPollInterval is how often an "on changes" Git sync checks the repository for changes
	// made there.
	gitPollInterval = 5 * time.Minute
	// exportTimeout bounds one run's network time.
	exportTimeout = 3 * time.Minute
)

var exportIntervals = map[string]time.Duration{
	store.ExportHourly: time.Hour,
	store.ExportDaily:  24 * time.Hour,
	store.ExportWeekly: 7 * 24 * time.Hour,
}

// exportState is the scheduler's memory. Guarded by mu.
type exportState struct {
	mu        sync.Mutex
	dir       string
	running   map[string]bool
	changedAt time.Time // the last data.changed; zero until something changes this session
	syncedAt  time.Time // the last successful server sync
	startedAt time.Time
	started   bool
	stop      chan struct{}
}

// folderConfig and gitConfig are the two shapes of export_destinations.config_json.
type folderConfig struct {
	Path string `json:"path"`
}

type gitConfig struct {
	// Provider is where the repository lives — "github", "gitlab", "bitbucket" or "other" — and
	// Auth how Companion signs in: "token" (an access token over HTTPS), "https" (a username and
	// password over HTTPS) or "ssh" (a deploy key Companion generates). Together they pick the
	// form the UI shows and, for a token, the username the host expects with it.
	Provider    string `json:"provider"`
	Auth        string `json:"auth"`
	RemoteURL   string `json:"remoteUrl"`
	Branch      string `json:"branch"`
	Username    string `json:"username,omitempty"`
	AuthorName  string `json:"authorName,omitempty"`
	AuthorEmail string `json:"authorEmail,omitempty"`
	// SSH: the public half of the deploy key, kept so the UI can show it again, and the host key
	// pinned on first contact. Both are public; the private key lives in the secret store.
	PublicKey string `json:"publicKey,omitempty"`
	HostKey   string `json:"hostKey,omitempty"`
}

const (
	gitAuthToken = "token"
	gitAuthHTTPS = "https"
	gitAuthSSH   = "ssh"
)

// tokenUsernames is the basic-auth username each host expects beside an access token.
var tokenUsernames = map[string]string{"github": "x-access-token", "gitlab": "oauth2", "bitbucket": "x-token-auth"}

// httpUsername is who an HTTPS push signs in as.
func (g gitConfig) httpUsername() string {
	if g.Username != "" {
		return g.Username
	}
	if g.Auth == gitAuthToken {
		if name := tokenUsernames[g.Provider]; name != "" {
			return name
		}
	}
	return "git"
}

// exportKeyComment labels the deploy key on the Git host.
const exportKeyComment = "Companion export"

// exportView is a destination as the UI sees it. The credential never crosses the bridge back —
// only whether this device holds one.
type exportView struct {
	*store.ExportDestination
	// HasCredential: this device can sign in. False on a Git export that synced here without
	// its credential — an account without end-to-end encryption keeps it on the device it was
	// typed into.
	HasCredential bool `json:"hasCredential"`
	// ThisDevice: this device is the one that runs the export (always, for a folder).
	ThisDevice bool `json:"thisDevice"`
	Running    bool `json:"running"`
}

// SetExportDir turns scheduled exports on for this shell and says where their bare Git
// repositories live (beside the database). Call before StartExportScheduler.
func (c *Core) SetExportDir(dir string) {
	c.exports.mu.Lock()
	c.exports.dir = dir
	c.exports.mu.Unlock()
}

func (c *Core) exportDir() string {
	c.exports.mu.Lock()
	defer c.exports.mu.Unlock()
	return c.exports.dir
}

func (c *Core) exportsEnabled() bool { return exportSupported && c.exportDir() != "" }

func (c *Core) exportCapabilities() ([]byte, error) {
	on := c.exportsEnabled()
	return json.Marshal(map[string]bool{"folder": on, "git": on})
}

func (c *Core) exportView(d *store.ExportDestination) exportView {
	c.exports.mu.Lock()
	running := c.exports.running[d.ID]
	c.exports.mu.Unlock()
	return exportView{ExportDestination: d, HasCredential: c.exportCredential(d) != "", ThisDevice: c.exportsHere(d), Running: running}
}

// exportDeviceID is this device's id, as the devices list knows it.
func (c *Core) exportDeviceID() string {
	info, err := c.store.DeviceInfo()
	if err != nil {
		return ""
	}
	return info.ID
}

// exportsHere reports whether this device is the one that runs a destination.
func (c *Core) exportsHere(d *store.ExportDestination) bool {
	return d.Kind != store.ExportKindGit || d.DeviceID == "" || d.DeviceID == c.exportDeviceID()
}

// claimExport makes this device a Git destination's exporter.
func (c *Core) claimExport(d *store.ExportDestination) {
	if info, err := c.store.DeviceInfo(); err == nil {
		d.DeviceID, d.DeviceName = info.ID, c.deviceDisplayName(info)
	}
}

// exportCredential is a Git destination's secret — token, password or SSH private key — from
// the row when it synced there, else from this device's secret store.
func (c *Core) exportCredential(d *store.ExportDestination) string {
	if d.CredentialEnc != "" {
		return d.CredentialEnc
	}
	if d.CredentialRef != "" && c.secrets != nil {
		if secret, err := c.secrets.GetSecret(d.CredentialRef); err == nil {
			return secret
		}
	}
	return ""
}

// setExportCredential decides where a Git credential lives — the same rule as CalDAV passwords
// and agent API keys. With end-to-end encryption unlocked it rides in the synced row: plaintext
// here, an enc$v1$ envelope on the wire and at rest on the server, and every device has it.
// Without, it stays in this device's secret store, so a repository write credential never
// reaches the server in the clear — and the export can only run from this device.
func (c *Core) setExportCredential(d *store.ExportDestination, secret string) error {
	ref := "export/" + d.ID
	if c.getMasterKey() != nil {
		d.CredentialEnc, d.CredentialRef = secret, ""
		if c.secrets != nil {
			_ = c.secrets.DeleteSecret(ref)
		}
		return nil
	}
	if c.secrets == nil {
		return errors.New("this device has nowhere safe to keep the credential")
	}
	if err := c.secrets.SetSecret(ref, secret); err != nil {
		return fmt.Errorf("store the credential: %w", err)
	}
	d.CredentialEnc, d.CredentialRef = "", ref
	return nil
}

func (c *Core) exportDestinationsList() ([]byte, error) {
	list, err := c.store.Exports.List()
	if err != nil {
		return nil, err
	}
	views := make([]exportView, 0, len(list))
	for _, d := range list {
		views = append(views, c.exportView(d))
	}
	return json.Marshal(views)
}

type exportSaveArgs struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Schedule string `json:"schedule"`
	Enabled  *bool  `json:"enabled"`
	// folder
	Path string `json:"path"`
	// git
	Provider    string `json:"provider"`
	Auth        string `json:"auth"`
	RemoteURL   string `json:"remoteUrl"`
	Branch      string `json:"branch"`
	Username    string `json:"username"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"authorEmail"`
	// Token is write-only — the access token, or the password for "https": set to store a new
	// one, empty to keep what's stored.
	Token string `json:"token"`
	// SSHKeyID names a key made by export.sshKey.generate for this destination to adopt. Empty
	// keeps the key an SSH destination already has.
	SSHKeyID string `json:"sshKeyId"`
}

func (c *Core) exportDestinationsSave(payload []byte) ([]byte, error) {
	if !c.exportsEnabled() {
		return nil, errors.New("scheduled exports aren't available on this device")
	}
	var args exportSaveArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	dest := &store.ExportDestination{Kind: args.Kind, Enabled: true}
	var previous json.RawMessage
	if args.ID != "" {
		existing, err := c.store.Exports.Get(args.ID)
		if err != nil {
			return nil, err
		}
		if existing == nil {
			return nil, errors.New("that export doesn't exist anymore")
		}
		dest, previous = existing, existing.Config
	}
	if args.Enabled != nil {
		dest.Enabled = *args.Enabled
	}
	switch args.Schedule {
	case store.ExportOnChanges, store.ExportHourly, store.ExportDaily, store.ExportWeekly, store.ExportManual:
		dest.Schedule = args.Schedule
	case "":
		if dest.Schedule == "" {
			dest.Schedule = store.ExportOnChanges
		}
	default:
		return nil, fmt.Errorf("unknown export schedule %q", args.Schedule)
	}

	token := ""
	var sshKey []byte
	switch dest.Kind {
	case store.ExportKindFolder:
		path := strings.TrimSpace(args.Path)
		if path == "" || !filepath.IsAbs(path) {
			return nil, errors.New("choose a folder to export to")
		}
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			return nil, fmt.Errorf("%q isn't a folder that exists", path)
		}
		dest.Config, _ = json.Marshal(folderConfig{Path: filepath.Clean(path)})
		if strings.TrimSpace(args.Name) == "" {
			args.Name = filepath.Base(path)
		}
	case store.ExportKindGit:
		var before gitConfig
		_ = json.Unmarshal(previous, &before)
		cfg, pastedToken, err := parseGitArgs(args)
		if err != nil {
			return nil, err
		}
		if token = strings.TrimSpace(args.Token); token == "" {
			token = pastedToken
		}
		if cfg.Auth == gitAuthSSH {
			token = ""
			// The pinned host key and the deploy key carry over while the remote stays put.
			cfg.PublicKey = before.PublicKey
			if before.RemoteURL == cfg.RemoteURL {
				cfg.HostKey = before.HostKey
			}
			if args.SSHKeyID != "" {
				if sshKey, err = c.pendingSSHKey(args.SSHKeyID); err != nil {
					return nil, err
				}
				if cfg.PublicKey, err = sshPublicKey(sshKey); err != nil {
					return nil, err
				}
			} else if before.Auth != gitAuthSSH {
				return nil, errors.New("generate an SSH key for this export first")
			}
		} else if token == "" && (previous == nil || before.Auth != cfg.Auth) {
			if cfg.Auth == gitAuthHTTPS {
				return nil, errors.New("enter the password")
			}
			return nil, errors.New("enter the access token")
		}
		dest.Config, _ = json.Marshal(cfg)
		if strings.TrimSpace(args.Name) == "" {
			args.Name = repoName(cfg.RemoteURL)
		}
	default:
		return nil, fmt.Errorf("unknown export kind %q", dest.Kind)
	}
	dest.Name = strings.TrimSpace(args.Name)
	if dest.Kind == store.ExportKindGit && dest.DeviceID == "" {
		c.claimExport(dest)
	}

	if err := c.store.Exports.Save(dest); err != nil {
		return nil, err
	}
	// The one secret a Git destination has — its token, its password, or its SSH private key.
	if secret := firstNonEmpty(token, string(sshKey)); dest.Kind == store.ExportKindGit && secret != "" {
		if err := c.setExportCredential(dest, secret); err != nil {
			return nil, err
		}
		if args.SSHKeyID != "" && c.secrets != nil {
			_ = c.secrets.DeleteSecret(pendingKeyRef(args.SSHKeyID))
		}
		if err := c.store.Exports.Save(dest); err != nil {
			return nil, err
		}
	}
	// Pointed somewhere new: what the old place held says nothing about this one.
	if previous != nil && string(previous) != string(dest.Config) && exportTargetChanged(dest.Kind, previous, dest.Config) {
		if err := c.store.Exports.ClearManifest(dest.ID); err != nil {
			return nil, err
		}
		if dest.Kind == store.ExportKindGit {
			c.removeExportRepo(dest.ID)
		}
	}
	c.emitExportChanged(dest.ID)
	if dest.Enabled && dest.Schedule != store.ExportManual && c.exportsHere(dest) {
		c.runExportAsync(dest.ID, false)
	}
	return json.Marshal(c.exportView(dest))
}

// exportTargetChanged reports whether an edit moved the destination (a new folder, remote or
// branch), as opposed to renaming it or changing who signs the commits.
func exportTargetChanged(kind string, before, after json.RawMessage) bool {
	if kind == store.ExportKindFolder {
		var a, b folderConfig
		_ = json.Unmarshal(before, &a)
		_ = json.Unmarshal(after, &b)
		return a.Path != b.Path
	}
	var a, b gitConfig
	_ = json.Unmarshal(before, &a)
	_ = json.Unmarshal(after, &b)
	return a.RemoteURL != b.RemoteURL || a.Branch != b.Branch
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// parseGitArgs validates a Git destination's form into its config, plus any token that was
// pasted inside the URL.
func parseGitArgs(args exportSaveArgs) (gitConfig, string, error) {
	// A pasted https://user:token@host URL is split, so the credential is never kept in — or
	// logged with — the URL.
	remote, urlUser, urlToken := splitGitCredentials(args.RemoteURL)
	cfg := gitConfig{
		Provider: args.Provider, Auth: args.Auth, RemoteURL: remote,
		Branch: strings.TrimSpace(args.Branch), Username: strings.TrimSpace(args.Username),
		AuthorName: strings.TrimSpace(args.AuthorName), AuthorEmail: strings.TrimSpace(args.AuthorEmail),
	}
	switch cfg.Provider {
	case "github", "gitlab", "bitbucket", "other":
	case "":
		cfg.Provider = "other"
	default:
		return cfg, "", fmt.Errorf("unknown Git provider %q", cfg.Provider)
	}
	switch cfg.Auth {
	case gitAuthToken, gitAuthHTTPS, gitAuthSSH:
	case "":
		cfg.Auth = gitAuthToken
	default:
		return cfg, "", fmt.Errorf("unknown way to sign in %q", cfg.Auth)
	}
	if err := validateGitRemote(remote, cfg.Auth); err != nil {
		return cfg, "", err
	}
	if cfg.Branch == "" {
		cfg.Branch = "main"
	}
	if strings.ContainsAny(cfg.Branch, " ~^:?*[\\") || strings.HasPrefix(cfg.Branch, "-") || strings.Contains(cfg.Branch, "..") {
		return cfg, "", fmt.Errorf("%q isn't a valid branch name", cfg.Branch)
	}
	if cfg.Auth == gitAuthSSH {
		cfg.Username = "" // SSH signs in as the user in the address (git@…)
		return cfg, "", nil
	}
	if cfg.Username == "" {
		cfg.Username = urlUser
	}
	if cfg.Auth == gitAuthHTTPS && cfg.Username == "" {
		return cfg, "", errors.New("enter the username")
	}
	return cfg, urlToken, nil
}

// validateGitRemote checks the address suits the way of signing in: an SSH address for a deploy
// key, an http(s) one for a token or a password. (A local path is a remote too — a bare
// repository on a mounted drive — and is how the tests run without a network.)
func validateGitRemote(remote, auth string) error {
	if remote == "" {
		return errors.New("enter the repository")
	}
	ssh := isSSHRemote(remote)
	switch {
	case auth == gitAuthSSH && ssh:
		return nil
	case auth == gitAuthSSH:
		return errors.New("an SSH export needs the repository's SSH address, like git@github.com:you/notes.git")
	case ssh:
		return errors.New("that's an SSH address — choose SSH, or use the repository's https:// address")
	case strings.HasPrefix(remote, "https://"), strings.HasPrefix(remote, "http://"), filepath.IsAbs(remote):
		return nil
	}
	return errors.New("enter the repository's https:// address")
}

// repoName is a default display name: the last path segment of the remote, without ".git".
func repoName(remote string) string {
	name := remote
	if i := strings.LastIndexAny(name, "/:"); i >= 0 {
		name = name[i+1:]
	}
	return strings.TrimSuffix(name, ".git")
}

// ---- SSH keys ---------------------------------------------------------------------------
//
// An SSH export signs in with a key pair Companion makes itself, so the user never handles a
// private key: they add the public half to the repository as a deploy key. The pair is made
// before the destination exists — the key has to be on the host before the first connection can
// work — so it waits in the secret store under a pending ref until a save adopts it (or the
// dialog is cancelled and discards it).

func pendingKeyRef(keyID string) string { return "export-key/" + keyID }

func (c *Core) pendingSSHKey(keyID string) ([]byte, error) {
	if c.secrets == nil {
		return nil, errors.New("this device has nowhere safe to keep the key")
	}
	key, err := c.secrets.GetSecret(pendingKeyRef(keyID))
	if err != nil || key == "" {
		return nil, errors.New("that SSH key isn't available anymore — generate a new one")
	}
	return []byte(key), nil
}

func (c *Core) exportSSHKeyGenerate() ([]byte, error) {
	if !c.exportsEnabled() {
		return nil, errors.New("scheduled exports aren't available on this device")
	}
	if c.secrets == nil {
		return nil, errors.New("this device has nowhere safe to keep the key")
	}
	private, public, err := generateSSHKey()
	if err != nil {
		return nil, err
	}
	keyID := uuid.NewString()
	if err := c.secrets.SetSecret(pendingKeyRef(keyID), string(private)); err != nil {
		return nil, fmt.Errorf("store the key: %w", err)
	}
	return json.Marshal(map[string]string{"keyId": keyID, "publicKey": public})
}

func (c *Core) exportSSHKeyDiscard(payload []byte) ([]byte, error) {
	var args struct {
		KeyID string `json:"keyId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.KeyID != "" && c.secrets != nil {
		_ = c.secrets.DeleteSecret(pendingKeyRef(args.KeyID))
	}
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) exportDestinationsDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	dest, err := c.store.Exports.Get(args.ID)
	if err != nil {
		return nil, err
	}
	if dest != nil {
		if c.secrets != nil {
			_ = c.secrets.DeleteSecret("export/" + dest.ID)
		}
		if dest.Kind == store.ExportKindGit {
			c.removeExportRepo(dest.ID)
		}
		if err := c.store.Exports.Delete(dest.ID); err != nil {
			return nil, err
		}
	}
	c.emitExportChanged(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

// exportDestinationsTakeOver makes this device a Git destination's exporter. It starts from a
// clean slate here — no manifest, no local repository — so its first run adopts the remote's
// head and writes the whole workspace over it.
func (c *Core) exportDestinationsTakeOver(payload []byte) ([]byte, error) {
	if !c.exportsEnabled() {
		return nil, errors.New("scheduled exports aren't available on this device")
	}
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	dest, err := c.store.Exports.Get(args.ID)
	if err != nil {
		return nil, err
	}
	if dest == nil || dest.Kind != store.ExportKindGit {
		return nil, errors.New("that export doesn't exist anymore")
	}
	if c.exportCredential(dest) == "" {
		return nil, errors.New("this device doesn't have that export's credential — edit the export and enter it here first")
	}
	c.claimExport(dest)
	if err := c.store.Exports.ClearManifest(dest.ID); err != nil {
		return nil, err
	}
	c.removeExportRepo(dest.ID)
	if err := c.store.Exports.Save(dest); err != nil {
		return nil, err
	}
	c.emitExportChanged(dest.ID)
	if dest.Enabled && dest.Schedule != store.ExportManual {
		c.runExportAsync(dest.ID, false)
	}
	return json.Marshal(c.exportView(dest))
}

func (c *Core) exportDestinationsRun(payload []byte) ([]byte, error) {
	if !c.exportsEnabled() {
		return nil, errors.New("scheduled exports aren't available on this device")
	}
	var args struct {
		ID string `json:"id"`
		// Force confirms a Git sync that paused itself over a large deletion (gitDeletionGuard).
		Force bool `json:"force"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	dest, err := c.store.Exports.Get(args.ID)
	if err != nil || dest == nil {
		return nil, errors.New("that export doesn't exist anymore")
	}
	if !c.exportsHere(dest) {
		return nil, fmt.Errorf("this export runs on %s", firstNonEmpty(dest.DeviceName, "another device"))
	}
	return json.Marshal(map[string]bool{"started": c.runExportAsync(args.ID, args.Force)})
}

// exportDestinationsCheck tries a Git remote with a credential before anything is saved: the one
// typed into the form (or the pending SSH key) or, editing a destination and leaving it blank,
// the stored one. It never pins a host key — only a real export does.
func (c *Core) exportDestinationsCheck(payload []byte) ([]byte, error) {
	if !c.exportsEnabled() {
		return nil, errors.New("scheduled exports aren't available on this device")
	}
	var args exportSaveArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	cfg, pastedToken, err := parseGitArgs(args)
	if err != nil {
		return nil, err
	}
	secret := firstNonEmpty(strings.TrimSpace(args.Token), pastedToken)
	if cfg.Auth == gitAuthSSH {
		secret = ""
		if args.SSHKeyID != "" {
			key, err := c.pendingSSHKey(args.SSHKeyID)
			if err != nil {
				return nil, err
			}
			secret = string(key)
		}
	}
	if args.ID != "" {
		if dest, _ := c.store.Exports.Get(args.ID); dest != nil {
			var before gitConfig
			_ = json.Unmarshal(dest.Config, &before)
			if secret == "" && before.Auth == cfg.Auth {
				secret = c.exportCredential(dest)
			}
			if before.RemoteURL == cfg.RemoteURL {
				cfg.HostKey = before.HostKey
			}
		}
	}
	if cfg.Auth == gitAuthSSH && secret == "" {
		return nil, errors.New("generate an SSH key for this export first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := checkGitRemote(ctx, cfg, secret); err != nil {
		return json.Marshal(map[string]any{"ok": false, "error": err.Error()})
	}
	return json.Marshal(map[string]any{"ok": true})
}

func (c *Core) emitExportChanged(id string) {
	payload, _ := json.Marshal(map[string]string{"id": id})
	c.emit(exportChangedEvent, payload)
}

func (c *Core) exportRepoPath(id string) string {
	return filepath.Join(c.exportDir(), "export", id+".git")
}

func (c *Core) removeExportRepo(id string) {
	if dir := c.exportDir(); dir != "" {
		_ = os.RemoveAll(c.exportRepoPath(id))
	}
}

// ---- running ----------------------------------------------------------------------------

// runExportAsync starts a run unless that destination is already running; it reports whether it
// started one.
func (c *Core) runExportAsync(id string, force bool) bool {
	c.exports.mu.Lock()
	if c.exports.running == nil {
		c.exports.running = map[string]bool{}
	}
	if c.exports.running[id] {
		c.exports.mu.Unlock()
		return false
	}
	c.exports.running[id] = true
	c.exports.mu.Unlock()
	c.emitExportChanged(id)
	go func() {
		defer func() {
			c.exports.mu.Lock()
			delete(c.exports.running, id)
			c.exports.mu.Unlock()
			c.emitExportChanged(id)
		}()
		c.runExport(id, force)
	}()
	return true
}

// runExport is one run: render the workspace, diff it against what the destination holds, apply
// the difference, and record how it went.
func (c *Core) runExport(id string, force bool) {
	dest, err := c.store.Exports.Get(id)
	if err != nil || dest == nil {
		return
	}
	started := time.Now()
	summary, pushPending, err := c.flushExport(dest, force)
	var success *time.Time
	message := ""
	if err != nil {
		message = err.Error()
	} else {
		now := time.Now()
		success = &now
	}
	var summaryJSON json.RawMessage
	if summary != nil && !isNilPointer(summary) {
		summaryJSON, _ = json.Marshal(summary)
	}
	_ = c.store.Exports.RecordRun(id, started, success, message, summaryJSON, pushPending)
}

// exportAttachments reads a document's bytes for the exporter: from the local blob store,
// fetching them from the server first if this device never downloaded them. A document that
// can't be had right now is export.ErrAttachmentUnavailable — skipped this run, not an error.
type exportAttachments struct{ c *Core }

func (a exportAttachments) Load(sha string) ([]byte, error) {
	local, ok := a.c.blobs.(blob.LocalStore)
	if !ok {
		return nil, export.ErrAttachmentUnavailable
	}
	if present, err := a.c.ensureLocalBytes(sha); err != nil || !present {
		return nil, export.ErrAttachmentUnavailable
	}
	r, err := local.Open(sha)
	if err != nil {
		return nil, export.ErrAttachmentUnavailable
	}
	defer r.Close()
	return io.ReadAll(r)
}

// attachmentReader is nil where there's no local blob store: attachments are then left out.
func (c *Core) attachmentReader() export.AttachmentReader {
	if _, ok := c.blobs.(blob.LocalStore); !ok {
		return nil
	}
	return exportAttachments{c}
}

// Ingest takes an attachment in (importfiles.Ingestor): the bytes go to the blob store and a
// document is made for them — unless a live document already holds exactly these bytes under
// this name, which is reused.
func (a exportAttachments) Ingest(filename string, content []byte) (string, bool, error) {
	local, ok := a.c.blobs.(blob.LocalStore)
	if !ok {
		return "", false, errNoLocalBlobStore
	}
	sha, size, err := local.Put(bytes.NewReader(content))
	if err != nil {
		return "", false, err
	}
	if existing, err := a.c.store.Documents.FindBySHA(sha, filename); err != nil {
		return "", false, err
	} else if existing != nil {
		return existing.ID, false, nil
	}
	kind := mime.TypeByExtension(strings.ToLower(filepath.Ext(filename)))
	doc, err := a.c.store.Documents.Create(store.CreateDocumentInput{Filename: filename, Mime: kind, Size: size, SHA256: sha})
	if err != nil {
		return "", false, err
	}
	a.c.emitDocumentChanged(doc.ID)
	return doc.ID, true, nil
}

// folderSummary is what one filesystem export did.
type folderSummary struct {
	export.Summary
	// Waiting: attachments whose bytes aren't on this device yet; they go out on a later run.
	Waiting int `json:"waiting,omitempty"`
}

func (c *Core) exportManifest(id string) ([]export.ManifestEntry, error) {
	rows, err := c.store.Exports.Manifest(id)
	if err != nil {
		return nil, err
	}
	manifest := make([]export.ManifestEntry, len(rows))
	for i, r := range rows {
		manifest[i] = export.ManifestEntry{Path: r.Path, EntityType: r.EntityType, EntityID: r.EntityID, SHA: r.SHA}
	}
	return manifest, nil
}

// flushExport runs a destination once and returns a summary of what it did (for the UI), whether
// a push is still owed, and the error if it failed. A folder is a one-way mirror; a Git
// repository syncs both ways (syncGit).
func (c *Core) flushExport(dest *store.ExportDestination, force bool) (any, bool, error) {
	if dest.Kind == store.ExportKindGit {
		var cfg gitConfig
		_ = json.Unmarshal(dest.Config, &cfg)
		ctx, cancel := context.WithTimeout(context.Background(), exportTimeout)
		defer cancel()
		return c.syncGit(ctx, dest, cfg, c.exportCredential(dest), force)
	}
	if dest.Kind != store.ExportKindFolder {
		return nil, false, fmt.Errorf("unknown export kind %q", dest.Kind)
	}
	files, err := export.Render(c.store, time.Local, c.attachmentReader())
	if err != nil {
		return nil, false, err
	}
	manifest, err := c.exportManifest(dest.ID)
	if err != nil {
		return nil, false, err
	}
	changes := export.Diff(manifest, files)
	var cfg folderConfig
	_ = json.Unmarshal(dest.Config, &cfg)
	applied, err := export.FolderSink{Root: cfg.Path}.Apply(changes)
	if rerr := c.recordExported(dest.ID, applied); rerr != nil && err == nil {
		err = rerr
	}
	summary := folderSummary{Summary: export.Summarize(applied)}
	if err == nil {
		summary.Waiting = len(changes) - len(applied)
	}
	return &summary, false, err
}

// recordExported moves applied changes into the manifest.
func (c *Core) recordExported(id string, applied []export.Change) error {
	var written []store.ExportManifestRow
	var removed []string
	for _, ch := range applied {
		if ch.Deleted() {
			removed = append(removed, ch.Path)
		} else {
			sha := ch.SHA
			if sha == "" {
				sha = export.File{Content: ch.Content}.SHA()
			}
			written = append(written, store.ExportManifestRow{Path: ch.Path, EntityType: ch.EntityType, EntityID: ch.EntityID, SHA: sha})
		}
	}
	return c.store.Exports.ApplyToManifest(id, written, removed)
}

// exportCommitMessage summarises a flush: counts on the subject line, the paths beneath.
func exportCommitMessage(changes []export.Change, s export.Summary) string {
	var parts []string
	if s.Added > 0 {
		parts = append(parts, fmt.Sprintf("%d added", s.Added))
	}
	if s.Updated > 0 {
		parts = append(parts, fmt.Sprintf("%d updated", s.Updated))
	}
	if s.Removed > 0 {
		parts = append(parts, fmt.Sprintf("%d removed", s.Removed))
	}
	lines := make([]string, 0, len(changes))
	for _, ch := range changes {
		mark := "M"
		if ch.Deleted() {
			mark = "D"
		} else if ch.Added {
			mark = "A"
		}
		lines = append(lines, mark+" "+ch.Path)
	}
	sort.Strings(lines)
	if len(parts) == 0 {
		parts = []string{"no changes"}
	}
	const maxLines = 50
	if len(lines) > maxLines {
		lines = append(lines[:maxLines], fmt.Sprintf("… and %d more", len(lines)-maxLines))
	}
	return "Companion: " + strings.Join(parts, ", ") + "\n\n" + strings.Join(lines, "\n") + "\n"
}

// ---- scheduling -------------------------------------------------------------------------

// StartExportScheduler begins running this device's exports on their schedules. A no-op where
// exports aren't available. Safe to call once; StopExportScheduler ends it.
func (c *Core) StartExportScheduler() {
	if !c.exportsEnabled() {
		return
	}
	c.exports.mu.Lock()
	if c.exports.started {
		c.exports.mu.Unlock()
		return
	}
	c.exports.started = true
	c.exports.startedAt = time.Now()
	stop := make(chan struct{})
	c.exports.stop = stop
	c.exports.mu.Unlock()

	removeTap := c.tapEvents(func(name string, _ []byte) {
		if name == dataChangedEvent {
			c.exports.mu.Lock()
			c.exports.changedAt = time.Now()
			c.exports.mu.Unlock()
		}
	})
	go func() {
		defer removeTap()
		ticker := time.NewTicker(exportTick)
		defer ticker.Stop()
		first := true
		for {
			c.exportTick(time.Now(), first)
			first = false
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
		}
	}()
}

func (c *Core) StopExportScheduler() {
	c.exports.mu.Lock()
	defer c.exports.mu.Unlock()
	if c.exports.started {
		close(c.exports.stop)
		c.exports.started = false
	}
}

func (c *Core) exportTick(now time.Time, startup bool) {
	list, err := c.store.Exports.List()
	if err != nil {
		return
	}
	c.exports.mu.Lock()
	changedAt, startedAt := c.exports.changedAt, c.exports.startedAt
	c.exports.mu.Unlock()
	live := map[string]bool{}
	for _, d := range list {
		live[d.ID] = true
		if d.Kind == store.ExportKindGit && now.Sub(startedAt) < exportStartupGrace {
			continue
		}
		// A Git export runs on its exporter device alone; here it is only settings.
		if c.exportsHere(d) && exportDue(d, now, changedAt, startup) {
			c.runExportAsync(d.ID, false)
		}
	}
	c.pruneExportRepos(live)
}

// pruneExportRepos removes the local bare repositories of destinations that no longer exist —
// deleted on another device, which this one only hears of through sync.
func (c *Core) pruneExportRepos(live map[string]bool) {
	dir := filepath.Join(c.exportDir(), "export")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if id, ok := strings.CutSuffix(e.Name(), ".git"); ok && e.IsDir() && !live[id] {
			_ = os.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
}

// exportDue decides whether a destination should run now. changedAt is the last time anything in
// the workspace changed this session (zero: nothing yet). On startup an "on changes" export runs
// once, to catch whatever changed in the moments before the app last quit — a run that finds
// nothing to write is cheap.
func exportDue(d *store.ExportDestination, now, changedAt time.Time, startup bool) bool {
	if !d.Enabled || d.Schedule == store.ExportManual {
		return false
	}
	sinceRun := time.Duration(1<<62 - 1)
	if d.LastRunAt != nil {
		sinceRun = now.Sub(*d.LastRunAt)
	}
	// Unfinished business — a failed run, or a commit waiting to be pushed — is retried on its
	// own clock, whatever the schedule.
	if (d.LastError != "" || d.PushPending) && d.LastRunAt != nil {
		return sinceRun >= exportRetry
	}
	switch d.Schedule {
	case store.ExportOnChanges:
		if d.LastRunAt == nil || startup {
			return true
		}
		// A Git sync also has the other side to listen to: changes made in the repository
		// announce themselves to nobody, so it looks every few minutes.
		if d.Kind == store.ExportKindGit && sinceRun >= gitPollInterval {
			return true
		}
		return !changedAt.IsZero() && changedAt.After(*d.LastRunAt) && now.Sub(changedAt) >= exportQuiet
	default:
		return sinceRun >= exportIntervals[d.Schedule]
	}
}

func isNilPointer(v any) bool {
	encoded, err := json.Marshal(v)
	return err != nil || string(encoded) == "null"
}

// ---- the server comes first -------------------------------------------------------------

const (
	syncRequestedEvent = "sync.requested"
	// syncFresh is how recent the last server sync must be for a Git sync to go ahead, and
	// syncWait how long it waits for one it asked for.
	syncFresh = 2 * time.Minute
	syncWait  = 45 * time.Second
	// exportStartupGrace keeps Git syncs from running before the shell has had the chance to
	// say whether a server is configured at all.
	exportStartupGrace = 45 * time.Second
)

// requestSync asks the shell for a server sync. The core never starts one itself: only the
// shell's sync provider knows whether an end-to-end encrypted account is unlocked, and a sync
// run while it's locked would push plaintext.
func (c *Core) requestSync() { c.emit(syncRequestedEvent, nil) }

func (c *Core) noteSynced() {
	c.exports.mu.Lock()
	c.exports.syncedAt = time.Now()
	c.exports.mu.Unlock()
}

// requireFreshSync holds a Git sync until the workspace has just synced with the server, asking
// for a sync if it hasn't. With no server configured there is nothing to be stale against.
func (c *Core) requireFreshSync(ctx context.Context) error {
	if c.sync.baseURL == "" {
		return nil
	}
	fresh := func() bool {
		c.exports.mu.Lock()
		defer c.exports.mu.Unlock()
		return time.Since(c.exports.syncedAt) <= syncFresh
	}
	if fresh() {
		return nil
	}
	c.requestSync()
	deadline := time.NewTimer(syncWait)
	defer deadline.Stop()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("couldn't sync with the Companion server first, so nothing was sent to Git — it will try again")
		case <-tick.C:
			if fresh() {
				return nil
			}
		}
	}
}
