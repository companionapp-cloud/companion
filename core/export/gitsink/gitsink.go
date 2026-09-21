//go:build !js && !ios && !android

// Package gitsink applies an export's change set to a Git repository and pushes it, with go-git —
// no `git` binary needed. Desktop only for now (the build tag keeps go-git out of the wasm and
// mobile cores, where it would cost several megabytes and has nowhere to run on a schedule).
//
// The repository is bare and lives in the app's data directory, not in any folder the user sees:
// commits are written as objects directly — blobs, then only the trees on the path of each
// change, then the commit — which needs no worktree or index, is milliseconds a flush however
// large the workspace, and keeps a live .git out of cloud-synced folders, where it corrupts.
//
// Export is one-way and the tree is fully derived from the database, so there is never anything
// to merge. Companion owns the branch it exports to: if the remote has moved on (someone pushed
// to it), the next push re-parents the exported tree onto the remote head — their commits stay in
// history, the exported tree wins.
package gitsink

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
	"github.com/go-git/go-git/v5/plumbing/transport"
	githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
	"golang.org/x/crypto/ssh"

	"companion/core/export"
)

const remoteName = "origin"

// repackThreshold is how many loose objects accumulate before a repack (a flush adds a handful).
const repackThreshold = 4000

// Config is one Git destination.
type Config struct {
	// RepoPath is the bare repository in the app's data directory; created on first use.
	RepoPath  string
	RemoteURL string
	Branch    string
	// Username and Token authenticate over HTTPS, as basic auth: an access token (the hosts take
	// it as the password, each with its own conventional username) or an account's username
	// and password. An empty token means no auth (a public or local remote).
	Username string
	Token    string
	// SSHKey, when set, authenticates over SSH instead: an OpenSSH-format private key
	// (GenerateKey), held in memory only — no ~/.ssh, no agent, no known_hosts file.
	SSHKey []byte
	// HostKey pins the SSH server's key, as an authorized_keys-format line. Empty trusts the
	// first key seen and reports it through OnHostKey so the caller can pin it; once pinned, a
	// different key is a hard error.
	HostKey   string
	OnHostKey func(line string)
	// AuthorName and AuthorEmail sign the commits. Always explicit, so go-git never reads
	// ~/.gitconfig.
	AuthorName  string
	AuthorEmail string
}

func (c Config) branchRef() plumbing.ReferenceName {
	return plumbing.NewBranchReferenceName(c.Branch)
}

func (c Config) remoteRef() plumbing.ReferenceName {
	return plumbing.NewRemoteReferenceName(remoteName, c.Branch)
}

func (c Config) auth() (transport.AuthMethod, error) {
	if len(c.SSHKey) > 0 {
		signer, err := ssh.ParsePrivateKey(c.SSHKey)
		if err != nil {
			return nil, fmt.Errorf("read the SSH key: %w", err)
		}
		user := c.Username
		if ep, err := transport.NewEndpoint(c.RemoteURL); err == nil && ep.User != "" {
			user = ep.User
		}
		if user == "" {
			user = "git"
		}
		return &sshAuth{user: user, signer: signer, pinned: c.HostKey, onHostKey: c.OnHostKey}, nil
	}
	if c.Token == "" {
		return nil, nil
	}
	user := c.Username
	if user == "" {
		user = "git"
	}
	return &githttp.BasicAuth{Username: user, Password: c.Token}, nil
}

// sshAuth is go-git's SSH auth with the client config built here, so the host key is checked
// against the destination's own pin rather than a known_hosts file (there isn't one to rely on,
// and go-git's default refuses to connect without it).
type sshAuth struct {
	user      string
	signer    ssh.Signer
	pinned    string
	onHostKey func(line string)
}

func (a *sshAuth) Name() string   { return "ssh-public-key" }
func (a *sshAuth) String() string { return "user: " + a.user + ", name: " + a.Name() }

func (a *sshAuth) ClientConfig() (*ssh.ClientConfig, error) {
	cfg := &ssh.ClientConfig{User: a.user, Auth: []ssh.AuthMethod{ssh.PublicKeys(a.signer)}, Timeout: 30 * time.Second}
	var pinned ssh.PublicKey
	if a.pinned != "" {
		key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(a.pinned))
		if err != nil {
			return nil, fmt.Errorf("read the pinned host key: %w", err)
		}
		pinned = key
		// Ask for the pinned key's type, or a server with several would offer another and look
		// like an impostor.
		cfg.HostKeyAlgorithms = hostKeyAlgorithms(key.Type())
	}
	cfg.HostKeyCallback = func(_ string, _ net.Addr, key ssh.PublicKey) error {
		if pinned == nil {
			if a.onHostKey != nil {
				a.onHostKey(strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))))
			}
			return nil
		}
		if key.Type() != pinned.Type() || string(key.Marshal()) != string(pinned.Marshal()) {
			return errors.New("the Git host's SSH key has changed since this export was set up. If the host really did rotate its key, remove this export and schedule it again")
		}
		return nil
	}
	return cfg, nil
}

// hostKeyAlgorithms are the signature algorithms that go with a host key type (an RSA key signs
// with SHA-2 these days).
func hostKeyAlgorithms(keyType string) []string {
	if keyType == ssh.KeyAlgoRSA {
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA}
	}
	return []string{keyType}
}

// GenerateKey makes the ed25519 key pair an SSH export authenticates with: the private key in
// OpenSSH PEM form (kept in the device's secret store) and the public key as the one line the
// user adds to the Git host as a deploy key. ed25519 only — small enough for any keychain.
func GenerateKey(comment string) (privatePEM []byte, publicKey string, err error) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	block, err := ssh.MarshalPrivateKey(private, comment)
	if err != nil {
		return nil, "", err
	}
	privatePEM = pem.EncodeToMemory(block)
	publicKey, err = PublicKey(privatePEM, comment)
	return privatePEM, publicKey, err
}

// PublicKey is the authorized_keys line for a private key made by GenerateKey.
func PublicKey(privatePEM []byte, comment string) (string, error) {
	signer, err := ssh.ParsePrivateKey(privatePEM)
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	if comment != "" {
		line += " " + comment
	}
	return line, nil
}

// IsSSH reports whether a remote is an SSH one: `ssh://…`, or the scp-like `git@host:path`.
func IsSSH(remote string) bool {
	ep, err := transport.NewEndpoint(remote)
	return err == nil && ep.Protocol == "ssh"
}

// SplitCredentials takes the user and password out of a pasted `https://user:token@host/…` URL,
// so a credential is never stored in — or logged with — the remote URL.
func SplitCredentials(raw string) (clean, username, token string) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User == nil {
		return strings.TrimSpace(raw), "", ""
	}
	username = u.User.Username()
	token, _ = u.User.Password()
	u.User = nil
	return u.String(), username, token
}

// open opens the bare repository, creating it — and pointing its remote at the configured URL —
// as needed.
func open(cfg Config) (*git.Repository, error) {
	repo, err := git.PlainOpen(cfg.RepoPath)
	if errors.Is(err, git.ErrRepositoryNotExists) {
		if err := os.MkdirAll(cfg.RepoPath, 0o700); err != nil {
			return nil, err
		}
		repo, err = git.PlainInit(cfg.RepoPath, true)
	}
	if err != nil {
		return nil, fmt.Errorf("open export repository: %w", err)
	}
	if err := repo.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, cfg.branchRef())); err != nil {
		return nil, err
	}
	remote, err := repo.Remote(remoteName)
	if err == nil && (len(remote.Config().URLs) != 1 || remote.Config().URLs[0] != cfg.RemoteURL) {
		if err := repo.DeleteRemote(remoteName); err != nil {
			return nil, err
		}
		remote = nil
	}
	if remote == nil || err != nil {
		if _, err := repo.CreateRemote(&config.RemoteConfig{Name: remoteName, URLs: []string{cfg.RemoteURL}}); err != nil {
			return nil, fmt.Errorf("set export remote: %w", err)
		}
	}
	return repo, nil
}

// Check reports whether the remote can be reached with the configured credential, by listing its
// refs. An empty repository is fine — that's what a new export starts from.
func Check(ctx context.Context, cfg Config) error {
	auth, err := cfg.auth()
	if err != nil {
		return err
	}
	remote := git.NewRemote(nil, &config.RemoteConfig{Name: remoteName, URLs: []string{cfg.RemoteURL}})
	_, err = remote.ListContext(ctx, &git.ListOptions{Auth: auth})
	if err == nil || errors.Is(err, transport.ErrEmptyRemoteRepository) {
		return nil
	}
	return friendly(err)
}

// Commit applies the changes on top of the branch and returns the new commit's hash — "" when
// they change nothing. The first commit of a new local repository parents onto the remote branch
// when there is one (a reinstall, or a repo that already has a README), which takes the network.
func Commit(ctx context.Context, cfg Config, changes []export.Change, message string, now time.Time) (string, error) {
	repo, err := open(cfg)
	if err != nil {
		return "", err
	}
	st := repo.Storer

	parent, err := head(repo, cfg.branchRef())
	if err != nil {
		return "", err
	}
	if parent == nil {
		if parent, err = adoptRemote(ctx, repo, cfg); err != nil {
			return "", err
		}
	}
	var base *object.Tree
	if parent != nil {
		if base, err = parent.Tree(); err != nil {
			return "", fmt.Errorf("read exported tree: %w", err)
		}
	}

	root := &node{children: map[string]*node{}}
	for i := range changes {
		root.insert(strings.Split(changes[i].Path, "/"), &changes[i])
	}
	tree, empty, err := patchTree(st, base, root)
	if err != nil {
		return "", err
	}
	if empty {
		if tree, err = writeTree(st, nil); err != nil {
			return "", err
		}
	}
	if parent != nil && parent.TreeHash == tree {
		return "", nil
	}

	var parents []plumbing.Hash
	if parent != nil {
		parents = []plumbing.Hash{parent.Hash}
	}
	hash, err := writeCommit(st, cfg, tree, parents, message, now)
	if err != nil {
		return "", err
	}
	if err := st.SetReference(plumbing.NewHashReference(cfg.branchRef(), hash)); err != nil {
		return "", err
	}
	return hash.String(), nil
}

// Push sends the branch to the remote. Idempotent: nothing to send is success. When the remote
// has commits this repository doesn't (a non-fast-forward), it fetches them, re-parents the
// exported tree onto the remote head, and pushes again.
func Push(ctx context.Context, cfg Config, now time.Time) error {
	repo, err := open(cfg)
	if err != nil {
		return err
	}
	local, err := head(repo, cfg.branchRef())
	if err != nil {
		return err
	}
	if local == nil {
		return nil // nothing exported yet
	}
	auth, err := cfg.auth()
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		err = repo.PushContext(ctx, &git.PushOptions{
			RemoteName: remoteName,
			RefSpecs:   []config.RefSpec{config.RefSpec(cfg.branchRef() + ":" + cfg.branchRef())},
			Auth:       auth,
		})
		if err == nil || errors.Is(err, git.NoErrAlreadyUpToDate) {
			break
		}
		if attempt > 0 || !nonFastForward(err) {
			return friendly(err)
		}
		remoteHead, ferr := fetch(ctx, repo, cfg)
		if ferr != nil {
			return friendly(ferr)
		}
		if remoteHead == nil {
			return friendly(err)
		}
		hash, werr := writeCommit(repo.Storer, cfg, local.TreeHash, []plumbing.Hash{remoteHead.Hash}, "Export on top of "+remoteHead.Hash.String()[:7]+"\n\nThe remote had commits this export didn't; the exported tree was applied over them.", now)
		if werr != nil {
			return werr
		}
		if err := repo.Storer.SetReference(plumbing.NewHashReference(cfg.branchRef(), hash)); err != nil {
			return err
		}
	}
	repackIfLarge(repo)
	return nil
}

// Remove deletes the local bare repository. The remote is untouched.
func Remove(cfg Config) error {
	if cfg.RepoPath == "" {
		return nil
	}
	return os.RemoveAll(cfg.RepoPath)
}

func head(repo *git.Repository, ref plumbing.ReferenceName) (*object.Commit, error) {
	r, err := repo.Reference(ref, true)
	if errors.Is(err, plumbing.ErrReferenceNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return repo.CommitObject(r.Hash())
}

// adoptRemote starts a new local repository from the remote branch's head, if it has one.
func adoptRemote(ctx context.Context, repo *git.Repository, cfg Config) (*object.Commit, error) {
	remoteHead, err := fetch(ctx, repo, cfg)
	if err != nil {
		return nil, friendly(err)
	}
	if remoteHead == nil {
		return nil, nil
	}
	if err := repo.Storer.SetReference(plumbing.NewHashReference(cfg.branchRef(), remoteHead.Hash)); err != nil {
		return nil, err
	}
	return remoteHead, nil
}

// fetch brings the remote branch's head commit in — depth 1: only its tree is ever needed — and
// returns it; nil when the remote has no such branch (or no commits at all).
func fetch(ctx context.Context, repo *git.Repository, cfg Config) (*object.Commit, error) {
	auth, err := cfg.auth()
	if err != nil {
		return nil, err
	}
	err = repo.FetchContext(ctx, &git.FetchOptions{
		RemoteName: remoteName,
		RefSpecs:   []config.RefSpec{config.RefSpec("+" + cfg.branchRef() + ":" + cfg.remoteRef())},
		Auth:       auth,
		Depth:      1,
		Tags:       git.NoTags,
		Force:      true,
	})
	switch {
	case err == nil, errors.Is(err, git.NoErrAlreadyUpToDate):
	case errors.Is(err, transport.ErrEmptyRemoteRepository), isNoMatchingRef(err):
		return nil, nil
	default:
		return nil, err
	}
	return head(repo, cfg.remoteRef())
}

func isNoMatchingRef(err error) bool {
	var noMatch git.NoMatchingRefSpecError
	return errors.As(err, &noMatch) || strings.Contains(err.Error(), "couldn't find remote ref")
}

func nonFastForward(err error) bool {
	return errors.Is(err, git.ErrNonFastForwardUpdate) || strings.Contains(err.Error(), "non-fast-forward")
}

// friendly rewords the transport errors a person can act on.
func friendly(err error) error {
	switch {
	case errors.Is(err, transport.ErrAuthenticationRequired), errors.Is(err, transport.ErrAuthorizationFailed):
		return errors.New("the Git host refused the credential. Check it, and that it can write to this repository")
	case errors.Is(err, transport.ErrRepositoryNotFound):
		return errors.New("the Git host has no repository at that URL (or the token can't see it)")
	}
	if msg := err.Error(); strings.Contains(msg, "unable to authenticate") || strings.Contains(msg, "no supported methods remain") {
		return errors.New("the Git host didn't accept the SSH key. Add the public key to the repository with write access, then try again")
	}
	return err
}

// ---- writing objects ---------------------------------------------------------------------

// node is a trie of the paths a flush touches.
type node struct {
	children map[string]*node
	change   *export.Change
}

func (n *node) insert(segments []string, change *export.Change) {
	child := n.children[segments[0]]
	if child == nil {
		child = &node{children: map[string]*node{}}
		n.children[segments[0]] = child
	}
	if len(segments) == 1 {
		child.change = change
		return
	}
	child.insert(segments[1:], change)
}

// patchTree rewrites only the directories on the path to a change. It returns the new tree's hash
// and whether the tree ended up empty (so the parent drops the entry).
func patchTree(st storer.EncodedObjectStorer, base *object.Tree, n *node) (plumbing.Hash, bool, error) {
	entries := map[string]object.TreeEntry{}
	if base != nil {
		for _, e := range base.Entries {
			entries[e.Name] = e
		}
	}
	for name, child := range n.children {
		if child.change != nil {
			if child.change.Deleted() {
				delete(entries, name)
				continue
			}
			content, err := child.change.Bytes()
			if err != nil {
				return plumbing.ZeroHash, false, fmt.Errorf("read %s: %w", child.change.Path, err)
			}
			h, err := writeBlob(st, content)
			if err != nil {
				return plumbing.ZeroHash, false, err
			}
			entries[name] = object.TreeEntry{Name: name, Mode: filemode.Regular, Hash: h}
			continue
		}
		var sub *object.Tree
		if e, ok := entries[name]; ok && e.Mode == filemode.Dir {
			t, err := object.GetTree(st, e.Hash)
			if err != nil {
				return plumbing.ZeroHash, false, err
			}
			sub = t
		}
		h, empty, err := patchTree(st, sub, child)
		if err != nil {
			return plumbing.ZeroHash, false, err
		}
		if empty {
			delete(entries, name)
		} else {
			entries[name] = object.TreeEntry{Name: name, Mode: filemode.Dir, Hash: h}
		}
	}
	if len(entries) == 0 {
		return plumbing.ZeroHash, true, nil
	}
	list := make([]object.TreeEntry, 0, len(entries))
	for _, e := range entries {
		list = append(list, e)
	}
	h, err := writeTree(st, list)
	return h, false, err
}

func writeBlob(st storer.EncodedObjectStorer, content []byte) (plumbing.Hash, error) {
	obj := st.NewEncodedObject()
	obj.SetType(plumbing.BlobObject)
	w, err := obj.Writer()
	if err != nil {
		return plumbing.ZeroHash, err
	}
	if _, err := w.Write(content); err != nil {
		w.Close()
		return plumbing.ZeroHash, err
	}
	if err := w.Close(); err != nil {
		return plumbing.ZeroHash, err
	}
	return st.SetEncodedObject(obj)
}

func writeTree(st storer.EncodedObjectStorer, entries []object.TreeEntry) (plumbing.Hash, error) {
	// Git orders tree entries as if directory names had a trailing slash.
	key := func(e object.TreeEntry) string {
		if e.Mode == filemode.Dir {
			return e.Name + "/"
		}
		return e.Name
	}
	sort.Slice(entries, func(i, j int) bool { return key(entries[i]) < key(entries[j]) })
	obj := st.NewEncodedObject()
	if err := (&object.Tree{Entries: entries}).Encode(obj); err != nil {
		return plumbing.ZeroHash, err
	}
	return st.SetEncodedObject(obj)
}

func writeCommit(st storer.EncodedObjectStorer, cfg Config, tree plumbing.Hash, parents []plumbing.Hash, message string, now time.Time) (plumbing.Hash, error) {
	sig := object.Signature{Name: cfg.AuthorName, Email: cfg.AuthorEmail, When: now}
	obj := st.NewEncodedObject()
	commit := &object.Commit{Author: sig, Committer: sig, Message: message, TreeHash: tree, ParentHashes: parents}
	if err := commit.Encode(obj); err != nil {
		return plumbing.ZeroHash, err
	}
	return st.SetEncodedObject(obj)
}

// repackIfLarge packs the loose objects once there are many. go-git has no gc of its own. Only
// ever called right after a successful push, so the remote holds everything if a repack is cut
// short (go-git #2370 deletes loose objects before the new pack is final); a failure is ignored —
// the repository is disposable by construction and the next flush rebuilds what it needs.
func repackIfLarge(repo *git.Repository) {
	loose, ok := repo.Storer.(storer.LooseObjectStorer)
	if !ok {
		return
	}
	count := 0
	_ = loose.ForEachObjectHash(func(plumbing.Hash) error {
		count++
		if count > repackThreshold {
			return storer.ErrStop
		}
		return nil
	})
	if count > repackThreshold {
		_ = repo.RepackObjects(&git.RepackConfig{})
	}
}
