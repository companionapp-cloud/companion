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
through our own tap. The bundle is ad-hoc signed (CI has no Apple signing identity),
so Homebrew must be told not to quarantine the download:

```bash
brew install --cask --no-quarantine companionapp-cloud/tap/companion
```

The cask lives in [`homebrew/Casks/companion.rb`](../../homebrew/Casks/companion.rb)
in this repo; the Release workflow stamps the version + sha256 and pushes the whole
`homebrew/` folder to `companionapp-cloud/homebrew-tap`. Edit it here, not in the tap.

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
