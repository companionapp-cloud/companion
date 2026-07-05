# @companion/mobile

The iOS + Android client (PLAN §4). It reuses the shared **data layer** and
**design-system primitives** from `@companion/app` / `@companion/design-system`, but
wraps them in a **mobile-native shell** (bottom tabs + stack) — the desktop `AppShell`
(hover rail, split-view, note tabs, window chrome) is intentionally *not* used here.
The Go core is compiled natively via **gomobile** instead of WASM (web) / HTTP (desktop).

```
apps/mobile/App.tsx
  └─ CoreProvider → SyncProvider → NotesProvider     (shared, from @companion/app)
       └─ src/MobileShell.tsx                        (mobile-only: bottom tabs + stack)
            ├─ NotesListScreen → NoteEditorScreen     (native title + @companion/editor body)
            ├─ Chat / Calendar / Tasks placeholders
            └─ Settings (reuses shared SettingsPanel)

apps/mobile/App.tsx ── createNativeBridge ──▶ modules/companion-core (Expo module)
                                                 │  Swift  → Core.xcframework
                                                 │  Kotlin → core.aar (jar + jniLibs)
                                                 ▼
                                        core/cmd/mobile (gomobile bind)
```

### What's shared vs. mobile-only

- **Shared** (`@companion/app`): `CoreProvider` / `SyncProvider` / `NotesProvider`
  (all UI-framework-agnostic data + sync logic), `SettingsPanel`, and every
  `@companion/design-system` primitive.
- **Mobile-only** (`apps/mobile/src`): the navigation shell — bottom tabs switch sections;
  a native stack pushes the list → full-screen editor. No hover, split-view, or windows.

The rich-text editor is the shared **`@companion/editor`** package. On native it resolves
to a `react-native-webview` hosting ProseMirror (bundled offline); on web/desktop it
resolves to ProseMirror mounted straight in the DOM. See that package's README for the
`build:editor` step. (Expo's `use dom` was tried first but its DomWebView crashes on mount
on Android + the New Architecture, so native drives a raw WebView instead.)

## Architecture

- **`modules/companion-core`** — a local Expo module wrapping the gomobile artifacts.
  - `initialize(dbPath)` opens the on-device SQLite database and registers an event sink.
  - `invoke(method, payloadJson): Promise<string>` dispatches a core method (JSON in / JSON out).
  - emits `onCoreEvent` for every core `EventHandler.OnEvent`.
  - Swift (`ios/CompanionCoreModule.swift`) and Kotlin
    (`android/.../CompanionCoreModule.kt`) implement the same surface against the
    gomobile-generated API (`MobileNew`/`MobileCore` on iOS, `Mobile.new_`/`Core` on Android).
- **`App.tsx`** opens the DB in the app documents directory, builds the `CoreBridge`
  via `@companion/core-bridge/native`, mounts the shared providers, and renders
  `<MobileShell />`.

## Building & running

The native artifacts are **not** committed (they're large and regenerated). Build them
into the module first, then run the app.

### 1. Build the gomobile artifacts (needs Xcode + Android SDK/NDK)

```sh
make mobile-artifacts   # builds Core.xcframework + core.aar into modules/companion-core
```

This runs `make core-ios` + `make core-android` and copies the results into
`modules/companion-core/ios/vendor/` and `modules/companion-core/android/libs/`.
Requires the one-time gomobile setup (`make gomobile-init`; see the repo README).

### 2. iOS — requires CocoaPods

CocoaPods needs a modern Ruby (the macOS system Ruby 2.6 is too old). Install one via
your version manager, e.g.:

```sh
asdf install ruby 3.3.5 && asdf global ruby 3.3.5   # or rbenv/chruby
gem install cocoapods
```

Then:

```sh
npm run ios -w @companion/mobile     # expo run:ios (runs prebuild + pod install + build)
```

### 3. Android

```sh
npm run android -w @companion/mobile # expo run:android (runs prebuild + gradle build)
```

`expo run:*` regenerates the native `ios/` and `android/` projects (continuous native
generation — both are gitignored) and links the autolinked `companion-core` module.

## Dev notes

- Metro is configured for the monorepo (`metro.config.js`): it watches the repo root and
  resolves hoisted `node_modules`.
- The JS/TS side is verifiable without a device: `npm run typecheck -w @companion/mobile`
  and `npx expo export --platform ios` (Metro bundle) both run in CI-style checks.
- Icons render cross-platform via `react-native-svg`; there is no web-only DOM in the
  shared UI (see `@companion/design-system` `platform.ts` for the web/native shims).
