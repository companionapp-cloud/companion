# Companion — Desktop (Wails v3)

The cheapest binding in the plan (PLAN §3.2): this app imports the Go `core/`
module directly — no cgo/FFI boundary — and hosts a Wails v3 webview running the
**same react-native-web UI as the web app** (`@companion/app`, built on
`@companion/design-system`).

## How it fits together

```
apps/desktop/frontend  (Vite + react-native-web)
  mounts @companion/app  ── createHttpBridge ──┐
        ▲                                       │  fetch("/invoke")
        │  built to frontend/dist,              ▼
        │  embedded + served by ───▶  bridge_handler.go ──▶ core/bridge.Invoke
        └────── EventSource("/events") ◀────────┘  (core "notes.changed" events)
```

- The shared UI is platform-agnostic React Native. The desktop shell
  (`frontend/src/main.tsx`) supplies a `CoreBridge` backed by **HTTP + SSE**
  (`createHttpBridge`); the web shell supplies a wasm-backed one. Same components,
  same screens.
- `core/bridge` speaks the universal contract: `Invoke(method, jsonBytes) ->
  jsonBytes` plus an event stream. `bridge_handler.go` adapts it onto HTTP and
  mounts it on the Wails AssetServer alongside the embedded frontend, so the webview
  talks to the in-process core with plain `fetch` / `EventSource`. (Generating typed
  Wails bindings is a later enhancement; HTTP keeps this free of the `wails3`
  codegen/npm-runtime step.)
- The core runs **natively** in the Go process (modernc SQLite) — no wasm on
  desktop. SQLite lives at `<user-config-dir>/Companion/companion.db`
  (macOS: `~/Library/Application Support/Companion/companion.db`), or under
  `Companion Dev/` for a dev build (see below).

## Run it

```bash
make desktop-run        # builds the frontend, then runs the app from source
```

A native window opens with the Notes UI. Requires a desktop session (it opens a
WebKit/WebView window) and the platform webview toolchain that Wails needs.

`make desktop-run`/`make desktop` build the react-native-web frontend into
`frontend/dist` first; the Go binary embeds it. Re-run after changing UI code.

A dev build (anything built without `DESKTOP_VERSION`) is a separate app from an
installed release, so it can run next to your real Companion without touching it:

- The database and everything beside it (blobs, secrets, shortcuts, agent working
  dirs) live in `Companion Dev/` instead of `Companion/`, starting empty. Migrations
  from a branch never land in the release's database.
- It takes its own single-instance lock, so launching it isn't handed off to the
  release sitting in the menu bar.
- `make desktop-app` bundles it as "Companion Dev" (`com.companion.desktop.dev`).
  WebKit keys localStorage (the sync config) by bundle id, so that's separate too,
  as are its notification permission and login item. `make desktop-run` runs
  unbundled, which WebKit already keys by executable name.

## Install a release (Homebrew)

Tagged releases build a universal `Companion.app` on a macOS runner and publish it
through our own tap:

```bash
brew install --cask companionapp-cloud/tap/companion
```

The bundle is ad-hoc signed (CI has no Apple signing identity) and Homebrew always
quarantines cask downloads, so the cask's `postflight_steps` strip the quarantine
attribute after install. That's why it's in our tap and not homebrew-cask.

The cask lives in [`homebrew/Casks/companion.rb`](../../homebrew/Casks/companion.rb)
in this repo; the Release workflow stamps the version + sha256 and pushes the whole
`homebrew/` folder to `companionapp-cloud/homebrew-tap`. Edit it here, not in the tap.

## Updates

Release builds update themselves, and updating isn't optional
([`updates.go`](updates.go), [`update_window.go`](update_window.go)):

- On launch, hourly and on wake, the app asks GitHub for the latest stable release.
- A launch shows nothing until that first check answers. If there's a newer release,
  the updater window ([`frontend/updater.html`](frontend/updater.html),
  [`frontend/src/updater.tsx`](frontend/src/updater.tsx)) opens instead of the main
  window and shows the download, the install and the restart. Otherwise the main
  window opens, as it also does when the check fails or hasn't answered in 5 seconds.
- An update found later takes the place of the app's windows (the main window and
  pop-outs; quick capture stays usable), without pulling Companion in front of
  another app. If none of them was on screen, it installs out of sight and the new
  version starts in the menu bar too. Opening Companion meanwhile — from the menu
  bar, the Dock or a notification — shows the updater window.
- The Wails v3 updater (`pkg/updater`) downloads `Companion-<version>-macos-universal.zip`,
  checks it against the sha256 GitHub recorded for the asset, and unpacks it. The app
  then checks the bundle is sealed (`codesign --verify --strict`) and is
  `com.companion.desktop` at the expected version. The updater's helper (this binary,
  re-run) swaps it in once the app quits and relaunches it.
- There's no quarantine to strip: only quarantine-aware downloaders (browsers,
  Homebrew) set `com.apple.quarantine`.
- A failed check stays silent (Companion is local-first). A failed install says why in
  the updater window, whose Continue gives the app back; a failure you've dismissed
  doesn't reopen the window by itself. Both retry on the next check. If the app can't
  replace itself (a standard account running it from `/Applications`, or App
  Translocation), the window offers `brew upgrade --cask companionapp-cloud/tap/companion`
  and the release page instead.

Only stable releases install. Tags like `v1.2.3-rc1` are published as prereleases,
and the updater skips them. The release workflow stamps the version into the binary
(`-ldflags "-X main.version=<tag>"`); dev builds have none and never update.

To watch it work, build an app that thinks it's old. With a version stamped it's a
release build, so it opens your real `Companion/` data (and runs this branch's
migrations on it). Quit any running Companion first, or the single-instance lock hands
the launch to that one. The updater window opens instead of the main window, and the
app replaces itself with the latest release:

```bash
make desktop-app DESKTOP_VERSION=0.0.1
open build/Companion.app
```

To check that the latest published release is installable (found, downloaded,
verified and unpacked, everything short of the swap):

```bash
go test -tags live -run TestLiveLatestReleaseInstalls .
```

## Build a binary

```bash
make desktop            # -> build/companion-desktop (frontend embedded)
```

## Test

The bridge is verified headlessly (no window needed) — the HTTP layer exercises the
real core through the same path the frontend uses:

```bash
go test .               # apps/desktop
go test ./core/...      # the shared core
```
