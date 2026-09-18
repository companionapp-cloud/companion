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
  (macOS: `~/Library/Application Support/Companion/companion.db`).

## Run it

```bash
make desktop-run        # builds the frontend, then runs the app from source
```

A native window opens with the Notes UI. Requires a desktop session (it opens a
WebKit/WebView window) and the platform webview toolchain that Wails needs.

`make desktop-run`/`make desktop` build the react-native-web frontend into
`frontend/dist` first; the Go binary embeds it. Re-run after changing UI code.

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
([`updates.go`](updates.go)):

- On launch, hourly and on wake, the app asks GitHub for the latest stable release.
- If it's newer, an "Updating Companion" screen
  ([`frontend/src/updates.tsx`](frontend/src/updates.tsx)) covers every window while
  the Wails v3 updater (`pkg/updater`) downloads `Companion-<version>-macos-universal.zip`,
  checks it against the sha256 GitHub recorded for the asset, and unpacks it. The app
  then checks the bundle is sealed (`codesign --verify --strict`) and is
  `com.companion.desktop` at the expected version. The updater's helper (this binary,
  re-run) swaps it in once the app quits and relaunches it.
- There's no quarantine to strip: only quarantine-aware downloaders (browsers,
  Homebrew) set `com.apple.quarantine`.
- A failed check stays silent (Companion is local-first). A failed install shows a
  dismissible notice. Both retry on the next check. If the app can't replace itself
  (a standard account running it from `/Applications`, or App Translocation), the
  notice offers `brew upgrade --cask companionapp-cloud/tap/companion` and the release
  page instead.
- If the main window was closed to the menu bar, the new version starts hidden too.

Only stable releases install. Tags like `v1.2.3-rc1` are published as prereleases,
and the updater skips them. The release workflow stamps the version into the binary
(`-ldflags "-X main.version=<tag>"`); dev builds have none and never update.

To watch it work, build an app that thinks it's old. Quit any running Companion first,
or the single-instance lock hands the launch to that one. The app replaces itself with
the latest release:

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
