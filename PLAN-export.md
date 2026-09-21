# Filesystem & Git export — research spike

Status: **spike, 2026-09-20. Nothing here is built and no decision is confirmed.**
Scope: one-way export of Companion data to (a) a folder, possibly inside cloud storage,
and (b) a Git repository that gets a commit every time the exporter flushes. Import is a
separate flow and out of scope. The question this spike answers: *how do we do Git on
desktop and mobile?*

Everything under "Measured" was run on this Mac (Go 1.27.1, go-git v5.19.2, gomobile from
the repo's toolchain). Everything under "Researched" has a source link; inferences are
labelled.

---

## 1. Recommendation

1. **Use [go-git](https://github.com/go-git/go-git) v5.19.x inside `core/`**, one
   implementation for desktop, iOS and Android, excluded from the wasm build with a build
   tag (same `_native.go` / `_js.go` split the core already uses for CalDAV, OAuth, unfurl).
2. **Commit by writing objects directly (blobs → patched trees → commit → ref), never
   through go-git's worktree/index API.** It is ~50× faster, and — more importantly — it
   means the Git repo does not need a worktree at all.
3. **Therefore: keep the repo bare, in app-private storage, decoupled from the exported
   folder.** Folder export and Git export become two independent *sinks* fed by the same
   rendered change set. "Commit on every flush" = the flush hands the same `[]Change` to
   both sinks.
4. **Push over HTTPS with a token first; SSH (in-app generated ed25519 deploy key) second.**
   Push is best-effort and retried; the commit is local and always succeeds.
5. **Stay off go-git v6 until GA** (still alpha; auth API mid-rewrite; a known_hosts
   regression that specifically hurts mobile).

Why not the alternatives: see §5.

---

## 2. Measured

Prototype: `spike.CommitPlumbing` (appendix A) vs. go-git's `Worktree` API. Workload: 5,000
markdown notes in 50 folders, then 300 flushes touching 3 files each (with occasional
deletes), one commit per flush.

| Approach | Initial 5,000-file commit | Per-flush commit | Notes |
|---|---|---|---|
| `Worktree.Add(path)` per file + `Commit` | **82 s** | 110 ms | `Add` does a full `Status()` walk per call — O(n²) |
| `AddWithOptions{All: true}` + `Commit` | 1.1 s | 42 ms | one status walk per flush; grows with repo size |
| **Direct objects, bare repo (recommended)** | **0.7 s** | **2.3 ms** (worst 72 ms) | no worktree, no index |
| Direct objects + mixed reset (folder doubles as worktree) | 0.9 s | 15 ms | system `git status` is clean afterwards |

Other measurements:

- **Correctness**: `git fsck --strict` passes on repos written by the direct-object path;
  system git reads history normally (301 commits).
- **Repo growth**: 301 commits → 7,721 loose objects / 6.3 MB. `Repository.RepackObjects`
  → 2 files / 5.9 MB in ~2.5 s, ~80 MB process memory. go-git has no auto-gc, so we must
  schedule this ourselves.
- **Push**: full push of that repo to a bare remote ~2 s; incremental push of one commit
  ~120 ms (local transport — network will dominate in reality).
- **Cross-compilation**: builds for `android/arm64`, `js/wasm`, `windows/amd64`,
  `linux/amd64`. **`gomobile bind -target=ios/arm64` succeeds** with a package that
  commits, pushes (HTTP + SSH auth types linked) and repacks.
- **Binary size**: iOS static slice 5.1 MB → 10.8 MB (**+5.7 MB per arch**, before app-level
  dead-stripping; today's Core slice is 34.5 MB). Desktop +4.9 MB. wasm +10.8 MB — hence
  the build tag.
- **Mobile-like environment** (`env -i`: no `HOME`, no `PATH`): init, commit, repack, push
  all work. One catch: go-git v5's **local-path transport shells out to the `git` binary**,
  so push tests must use an in-process HTTP remote, not a temp-dir remote. Irrelevant in
  production (mobile only ever pushes over HTTPS/SSH).

---

## 3. Researched: go-git

- **Versions**: v5.19.2 (2026-07-29) is stable; v5 is a security/backport branch. v6 is at
  alpha.5 with no beta/RC; its Push/Fetch auth API changed (`Auth` field replaced by
  `ClientOptions`) and is still moving.
  [releases](https://github.com/go-git/go-git/releases) ·
  [v5→v6 migration](https://go-git.github.io/docs/tutorials/migrating-from-v5-to-v6/)
- **Why the worktree API is slow**: `Add(path)`, `AddGlob`, `AddWithOptions{All}` and
  `Commit{All}` all call `Status()` (full worktree walk) in both v5.19.2 and v6-alpha.5
  (verified in source). `AddWithOptions{SkipStatus: true}` avoids it for existing regular
  files only. Long-standing open perf issue:
  [#181](https://github.com/go-git/go-git/issues/181).
- **Maintenance**: `RepackObjects` and `Prune` exist; `gc`/`fsck` do not
  ([COMPATIBILITY.md](https://github.com/go-git/go-git/blob/main/COMPATIBILITY.md)).
  `RepackObjects` is a *full* repack, not incremental.
- **⚠ Open data-loss bug [#2370](https://github.com/go-git/go-git/issues/2370)**:
  `RepackObjects` deletes loose objects before the new pack is finalised; a failed close
  (disk full, app killed) loses them. Reproduced on v6; v5.19.2 has the same code ordering
  (so presumably the same bug — inference). Mitigation in §4.6.
- **Auth**: for GitHub/GitLab/Bitbucket tokens use `http.BasicAuth` with the token as the
  password (`TokenAuth` is bearer, which those hosts reject). SSH keys load from PEM bytes
  in memory (`ssh.NewPublicKeys`) — no `~/.ssh`, no agent. With a custom `HostKeyCallback`
  v5 never touches known_hosts; **v6-alpha.5 regresses this** and fails when no known_hosts
  file exists ([#1234](https://github.com/go-git/go-git/issues/1234)).
- **Global config**: v5 only reads `~/.gitconfig` when `Author`/`Tagger` is nil. Always set
  `Author` and `Committer` explicitly and it is never read.
- **Shallow**: `Depth` on clone/fetch works and push from a shallow repo is supported, but
  it is a recurring bug source ([#2367](https://github.com/go-git/go-git/issues/2367),
  [#2409](https://github.com/go-git/go-git/issues/2409)). Prefer fetch + reset over `Pull`.
  Partial clone (`Filter`) is v6-only and immature.
- **No Git LFS** ([#381](https://github.com/go-git/go-git/issues/381)). Attachments are
  either ordinary blobs or left out (decision D5).
- **Signing**: GPG built in (`SignKey`), custom `Signer` interface for SSH signing. Not
  needed for v1.
- **Security cadence**: 10 advisories in 2026, all patched in v5.19.2 — active, but we must
  track releases ([advisories](https://github.com/go-git/go-git/security/advisories)).
- **Prior art for go-git under gomobile**:
  [git-calendar/core](https://github.com/git-calendar/core) (go-git v5.19.2, Android + iOS +
  wasm) and [mvbasov/OMN-Go](https://github.com/mvbasov/OMN-Go) (markdown notes, Android
  AAR, F-Droid). Tip from OMN-Go: anything that reaches `reflect.Value.MethodByName`
  (`text/template`, `html/template`) defeats linker dead-code elimination and inflates the
  go-git cost — worth checking whether the core already links those.

---

## 4. Proposed design

### 4.1 Shape

```
store ──▶ exporter.Render(changed entities) ──▶ []Change{Path, Content|nil}
                                                   │
                         ┌─────────────────────────┼──────────────────────────┐
                         ▼                                                    ▼
                FolderSink (os I/O or                              GitSink (bare repo in app
                shell-provided writer)                             data dir; commit + push)
```

- `core/export`: renderer (entities → deterministic paths + markdown with front matter),
  change detection, flush scheduling.
- `core/export/gitsink` (`//go:build !js`): the appendix-A committer, push, repack.
- A destination is a row (kind = folder | git, config, last flush, last error). A user can
  have both; they don't depend on each other.

### 4.2 Change detection

The `dirty` column belongs to the sync engine (cleared on push), so the exporter cannot
reuse it. Proposal: a per-destination **manifest** table `(destination_id, entity_id, path,
content_sha)`. A flush renders candidates, diffs against the manifest, and emits only real
changes. This handles renames (title change → delete old path + write new) and deletes
deterministically, and makes "rebuild from scratch" trivial. Trigger: debounce on the
existing `data.changed` event (order of seconds to a minute — decision D3), plus flush
after a sync pull completes.

### 4.3 Committing

Appendix A, in short: load the parent commit's tree, rewrite only the directories on the
path of each change, write the commit, move the ref. No-op flushes produce no commit.
Commit message: generated summary (`Update 3 notes: Foo, Bar, Baz`), author
`Companion <device name>`, always explicit.

If a **desktop user wants the exported folder to be a real working copy** (so they can
`cd` in and run `git log`), the same committer works against a non-bare repo followed by a
mixed reset (15 ms/flush measured). Recommend *not* offering this when the folder is inside
iCloud/Dropbox/Drive — a live `.git` inside a syncing folder is a well-known corruption
hazard.

### 4.4 Multiple devices exporting to one remote

Export is one-way and the tree is fully derived from the database, so there is never
anything to merge: on a rejected (non-fast-forward) push, fetch, re-parent our tree on the
remote head, push again. The real risk is a device with **stale sync state** overwriting
newer content, then the fresher device flipping it back — noisy history, not data loss.
Options (decision D2): (a) one designated exporter device per Git destination — simplest,
and what I'd ship first; (b) any device, but flush only right after a successful sync pull.

### 4.5 Auth & secrets

- v1: HTTPS + personal access token (fine-grained, single-repo, contents:write). Works for
  GitHub, GitLab, Gitea, Bitbucket, self-hosted.
- v1.1: SSH — generate an ed25519 key in-app, show the public key for the user to add as a
  deploy key; trust-on-first-use host key pinned in the destination config.
- Later: GitHub OAuth device flow (no client secret needed) reusing `core/oauth`.
- Without E2EE the credential sits in `core/secrets`. The mobile secret store is still the
  plaintext `secrets.json` FileStore (PLAN §6.8 flags SecureStore as the hardening
  upgrade) — a Git write credential raises the priority of that upgrade.

#### Making the credential cross-device

Reuse the CalDAV account pattern (PLAN-caldav.md §1, `credentialEnc` / `credentialRef`)
unchanged — it already solves exactly this:

- The Git destination is a **synced row**. `credentialEnc` (the PAT, or the OpenSSH-encoded
  ed25519 private key) is a protected field in `core/crypto/rows.go`, so it leaves the
  device only sealed under the E2EE master key. The sync server never sees it; a new device
  that unlocks E2EE has the credential with no extra step.
- **Without E2EE, the credential does not sync**: it goes to the device secret store via
  `credentialRef`, and each device that wants to export asks for it again. Do *not* route
  Git credentials through `PUT /v1/secrets` (server-side AES-GCM): the server can read
  those, and a repo write credential should not be server-readable.
- Also protected + synced on the row: remote URL, branch, username, the SSH **public** key
  (so any device can re-show "add this deploy key"), and the **pinned host key** — trust on
  first use happens once per account, not once per device, and a changed host key is a
  hard error everywhere.
- Why master-key wrapping is proportionate: the credential guards a repo holding a
  plaintext copy of the same notes the master key already protects. That holds only if
  the credential is **scoped to that one repo** — a deploy key or a fine-grained PAT. A
  classic `repo`-scope PAT reaches every repo the user has; the UI should steer hard away
  from it (detect `ghp_` prefix → warn).
- **SSH: one shared key per destination (synced), not a key per device.** Per-device keys
  keep the private key from ever travelling and allow per-device revocation, but cost a
  manual "add deploy key" on the host for every device, for a repo-scoped key whose
  compromise is already bounded. Revocation story for the shared key: "Rotate key" on any
  device generates a new pair, syncs it, and shows the new public key; the user deletes
  the old deploy key on the host. Removing a lost device from the account should prompt
  this rotation.
- Interaction with D2: with a single designated exporter device, only that device ever
  *uses* the credential. Syncing it anyway is what makes "move export to another device" a
  one-tap change rather than a re-setup.
- On-device at rest: like CalDAV, the local row holds the credential in plaintext SQLite
  (the row cipher applies on push). Same exposure as the notes themselves; hardening that
  is the SecureStore/SQLCipher question, not a Git-specific one.
- Hygiene: never log remote URLs with embedded credentials (store the token separately
  from the URL, reject `https://user:token@…` input by splitting it), never let the
  credential cross the bridge back to the UI after entry (CalDAV/OAuth rule: "tokens never
  cross the bridge"), and wipe `credentialEnc` + the secret-store ref on destination delete.

### 4.6 Repo hygiene

- Repack when loose objects exceed a threshold (~2–5k), only when idle, **only after a
  successful push** (so the remote is a backup against #2370), and with a free-space check.
- The local repo is disposable by construction: if it is ever corrupt, delete it, shallow
  fetch the remote head (or start an orphan history), re-render, carry on.
- New device / reinstall: `Depth: 1` fetch of the branch head, then commit on top.

### 4.7 E2EE note

Export writes **plaintext** to disk and to a third-party Git host. That is the point of the
feature, but the settings UI should say so plainly for accounts with E2EE enabled.

---

## 5. Alternatives considered

| Option | Verdict |
|---|---|
| **Shell out to system `git`** | Desktop-only; absent by default on Windows and on macOS without CLT. Could be an optional desktop backend later (gets credential helpers, signing, LFS for free) but cannot be the only implementation. |
| **libgit2 via git2go** | git2go last released 2022 (libgit2 1.5; libgit2 is now 1.9.x). Needs cgo + cross-compiling libgit2/libssh2/TLS for every mobile ABI. Rejected. |
| **libgit2 natively (Swift/Kotlin)** | What Working Copy, GitSync and PuppyGit use; licence (GPLv2 + linking exception) is App Store-safe. But it is two more native integrations plus libssh2 + OpenSSL per ABI, outside the Go core. GitJournal [left libgit2 for go-git](https://play.google.com/store/apps/details?id=io.gitjournal.gitjournal) in 2022 because "Golang is far easier to cross compile". Rejected. |
| **isomorphic-git in the RN layer** | The [Obsidian Git plugin](https://github.com/Vinzent03/obsidian-git) uses it on mobile and calls it "very unstable": no SSH, repo size limited by memory (whole packfiles held in RAM), crashes on clone/pull; the plugin now points mobile users elsewhere. No maintained RN fs shim, and it would put export logic outside the core. Rejected. |
| **Provider REST APIs** (GitHub [`createCommitOnBranch`](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/), GitLab commits `actions[]`, Gitea `ChangeFiles`) | Genuinely attractive for mobile: atomic multi-file commits over plain HTTPS, no local repo, fits short background windows. But per-provider code, no generic/self-hosted/SSH remotes, and GitHub's secondary limit of ~500 content-creating requests/hour forces batching. Keep as a possible later "GitHub-only lightweight mode"; not the foundation. |
| **gitoxide (Rust)** | Push is still unimplemented. Rejected. |

---

## 6. Platform constraints

The headline: **Git is the easy half on mobile. The arbitrary-folder export is the hard
half** — and the two are independent, which is another argument for the two-sink shape.

### 6.1 Git sink — all platforms

The bare repo lives next to the database (`<data dir>/export/<destination id>.git`), where
the core's plain `os` I/O already works on every native platform. No pickers, no
permissions, no entitlements. Push needs only outbound HTTPS/SSH.

### 6.2 Background execution (when does the push happen?)

- **iOS**: `beginBackgroundTask` gives ~30 s total; suspended apps have their sockets
  reclaimed, and Go's network stack does not recover on its own
  ([Tailscale report](https://github.com/tailscale/tailscale/issues/21353),
  [TN2277](https://developer.apple.com/library/archive/technotes/tn2277/_index.html)).
  Background `URLSession` can't carry the git protocol. iOS 26's
  `BGContinuedProcessingTask` is for user-initiated work only and Apple explicitly
  excludes backups/sync.
- **Android**: a unique one-time WorkManager job with a `CONNECTED` constraint and backoff
  is enough; no foreground service needed.
- **Design consequence**: commit locally at flush time (2 ms — always fits), mark the
  destination *push pending*, attempt the push under a background-task assertion, and
  retry on next foreground / WorkManager run. Push must be idempotent and treat a torn
  connection as routine. The user-visible promise is "committed immediately, pushed when
  possible", with a last-pushed timestamp in settings.

### 6.3 Folder sink — desktop

Wails folder picker + plain `os` writes. Works today for a local folder or any desktop
cloud client's synced folder (iCloud Drive, Dropbox, Google Drive, OneDrive all appear as
ordinary directories). Write temp-file-then-rename so sync clients never see a torn file.

### 6.4 Folder sink — iOS

- Folder picker (`UIDocumentPickerViewController`, `.folder`) returns a security-scoped
  URL granting recursive access; persist it as a **bookmark** and re-prompt when stale
  ([Apple](https://developer.apple.com/documentation/uikit/providing-access-to-directories)).
  Expo's `Directory.pickDirectoryAsync` does not persist the bookmark on iOS, so this is a
  small addition to the existing `companion-core` Expo module.
- Go's POSIX I/O works inside the scoped folder while access is active — not documented by
  Apple in so many words, but a-Shell, Working Copy (libgit2) and GitSync all do exactly
  this.
- **Wrap writes in `NSFileCoordinator`** for iCloud: a 2026 stress test saw 3/40
  uncoordinated appends corrupt vs 0/40 coordinated
  ([write-up](https://dev.to/simple_memo/taking-apart-the-write-path-into-another-apps-icloud-folder-2pdp)).
  Shape: Swift takes the coordinated write on the folder, calls the Go flush inside the
  accessor block.
- **Which providers work**: iCloud Drive and On My iPhone reliably; Dropbox since its 2024
  Files integration ([iA](https://ia.net/topics/i-want-you-back-the-dropbox-remix)).
  Google Drive / OneDrive folder picking is historically greyed out (Apple bug
  FB9703910) — current status unverified, needs a device test.
- Zero-permission fallback: export into the app's own Documents dir and expose it in Files
  (`expo-file-system` plugin: `enableFileSharing` + `supportsOpeningDocumentsInPlace`), or
  the app's iCloud ubiquity container.
- **Never put `.git` in iCloud Drive**: conflict handling creates numbered duplicates under
  `.git/refs` and git dies with `bad object`
  ([example](https://architchandra.com/articles/a-side-effect-of-storing-a-git-repository-in-icloud-drive)).
  Working Copy keeps `.git` in its own sandbox for the same reason. This is the
  independent confirmation of recommendation 3.

### 6.5 Folder sink — Android

- SAF (`ACTION_OPEN_DOCUMENT_TREE`) yields `content://` URIs; native code cannot list,
  mkdir or rename by path. So the Go core **cannot** write a picked folder directly.
- `MANAGE_EXTERNAL_STORAGE` would give real paths, but Play policy requires it to be core
  functionality; the official Syncthing app was discontinued over exactly this. A
  notes app with export as a secondary feature is a weak candidate (inference). Don't
  build on it.
- Shape: the core's `FolderSink` takes a **shell-provided writer** on Android — Go emits
  `(path, bytes | delete)`, a small Kotlin writer applies it via `DocumentsContract` (not
  `DocumentFile`, which is 10×+ slower). Because the manifest means we only ever write
  changed files, SAF's per-call cost is tolerable.
- Few cloud providers expose writable SAF *trees* (Google Drive reportedly does not —
  unverified for 2026). Realistic Android story: local/shared-storage folder, and users
  who want cloud pair it with their own sync tool — or just use the Git sink.

### 6.6 Credentials

`expo-secure-store` (Keychain / Keystore) comfortably holds a PAT or an ed25519 key
(~400–500 bytes); RSA-4096 PEM exceeds the historical ~2 KB iOS limit, so generate ed25519
only. Use `AFTER_FIRST_UNLOCK` so a background push can read it while locked.
**GitHub auth without a backend**: the device flow needs no client secret, and with a
*GitHub App* (rather than an OAuth App) the token is scoped to the repos the user picks —
the best later upgrade over PATs. GitHub's PKCE web flow still requires a secret. GitLab
supports PKCE for public clients and device grant (GA in 17.9).

---

## 7. Not verified by this spike

- go-git running **on a device** (only `gomobile bind` for iOS and a compile for Android
  were done here; git-calendar and OMN-Go are the evidence it runs).
- Push + repack **memory on a phone** (80 MB on the Mac for a 5k-file / 300-commit repo).
- A real **HTTPS/SSH push** from the prototype (only the local transport was exercised).
- Whether the #2370 repack data-loss path is reachable on v5.
- iOS folder picking for Google Drive / OneDrive; Android SAF tree support per cloud
  provider. Both need a device test.
- The research agent read web pages through a summariser, so quoted strings in §6 are as
  relayed, not checked against raw page text.

Suggested next step: a half-day device check — drop the appendix-A committer behind a
temporary `export.gitSpike` bridge method, bind, and push to a scratch GitHub repo from an
iPhone and an Android device, watching memory and the suspend-mid-push behaviour.

---

## 8. Open decisions

- **D1** Bare repo in app data (recommended) vs. exported folder as working copy (desktop
  opt-in?).
- **D2** Single exporter device vs. any device after sync pull.
- **D3** Flush debounce interval; is there a "commit now" button?
- **D4** Repo layout and file naming (collisions, renames, front matter schema) — shared
  with the folder export, not Git-specific.
- **D5** Attachments in Git: ordinary blobs with a size cap, or excluded. (No LFS.)
- **D6** HTTPS+PAT only for v1?

---

## Appendix A — the committer (from the spike, `git fsck --strict` clean)

```go
// Change is one file in a flush. Nil Content deletes the path.
type Change struct {
	Path    string
	Content []byte
}

// patchTree rewrites only the directories on the path to a change. Returns the new tree
// hash and whether the tree ended up empty (so the parent drops the entry).
func patchTree(st storer.EncodedObjectStorer, base *object.Tree, n *node) (plumbing.Hash, bool, error) {
	entries := map[string]object.TreeEntry{}
	if base != nil {
		for _, e := range base.Entries {
			entries[e.Name] = e
		}
	}
	for name, child := range n.children {
		if child.change != nil {
			if child.change.Content == nil {
				delete(entries, name)
				continue
			}
			h, err := writeBlob(st, child.change.Content) // NewEncodedObject + SetType(Blob) + Write + SetEncodedObject
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
	t := &object.Tree{}
	for _, e := range entries {
		t.Entries = append(t.Entries, e)
	}
	// Git orders tree entries as if directory names had a trailing slash.
	sort.Slice(t.Entries, func(i, j int) bool { return sortKey(t.Entries[i]) < sortKey(t.Entries[j]) })
	obj := st.NewEncodedObject()
	if err := t.Encode(obj); err != nil {
		return plumbing.ZeroHash, false, err
	}
	h, err := st.SetEncodedObject(obj)
	return h, false, err
}
```

The caller builds the `node` trie from `[]Change`, calls `patchTree` with the parent
commit's tree, skips the commit when the root hash is unchanged, otherwise encodes an
`object.Commit` (explicit author/committer) and moves `refs/heads/<branch>`.
