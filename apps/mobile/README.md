# Companion — Mobile (Expo + gomobile)

Milestone 3: iOS + Android. The Go core is compiled with **`gomobile bind`** into a
native library (`Core.xcframework` / `core.aar`), wrapped by a **local Expo module**
that exposes `invoke` + an event emitter to JS. The shared React Native UI
(`@companion/app`) renders on device via Metro — the same screens as web/desktop.

```
@companion/app  (shared RN UI)
      │ CoreBridge
      ▼
@companion/core-bridge/native  ── createNativeBridge({ module, emitter })
      │  invoke(method, jsonPayload) -> Promise<jsonResult>
      ▼
local Expo module (Swift / Kotlin)
      │  calls the bound Go type
      ▼
core/cmd/mobile  (gomobile)  ── Core.Invoke([]byte) / SetEventHandler
      │
      ▼
core/  (domain · store[modernc sqlite] · bridge)   — same tested logic as desktop
```

## What's done (verified headlessly)

- **`core/cmd/mobile`** — the gomobile-bindable package: `New(dbPath)`, `Invoke`,
  `SetEventHandler(EventHandler)`, `Close`. Only basic/`[]byte`/`error`/interface
  types cross the boundary, per gomobile's constraints. Compiles + unit-tested
  (`go test ./core/cmd/mobile`).
- **Build targets** — `make gomobile-init`, `make core-android` (→ `build/core.aar`),
  `make core-ios` (→ `build/Core.xcframework`).
- **`@companion/core-bridge/native`** — `createNativeBridge` adapting the Expo
  module to the shared `CoreBridge` (dependency-injected; no Expo dep, typechecks).

## What remains (needs the mobile toolchain — not in this environment)

Requires **Xcode**, **Android SDK + NDK**, a JDK, `gomobile`, and **Expo/EAS** (the
gomobile native module means a custom dev client — no Expo Go; PLAN §10).

1. Scaffold the Expo app here: `npx create-expo-app apps/mobile` (SDK 52+).
2. Build the core artifact: `make gomobile-init && make core-android core-ios`.
3. **Local Expo module** wrapping the artifact. Its JS surface must match
   `@companion/core-bridge/native`:
   - `invoke(method: string, payloadJson: string): Promise<string>` → calls the bound
     `Core.Invoke`. Open the DB at `FileSystem.documentDirectory + "companion.db"`.
   - an event emitter firing `onCoreEvent` with `{ name, payload }` for each
     `EventHandler.OnEvent` (implement the Go `EventHandler` interface in Swift/Kotlin
     and forward to the module's `sendEvent`).
4. Mount `@companion/app`'s `App` with `createNativeBridge({ module, emitter })`.
5. Editor via **`'use dom'`** for the (future) `packages/editor` ProseMirror
   component (PLAN §6.1).

### Shared-UI portability to native (before Metro will render `@companion/app`)

The UI was built web-first (react-native-web); these need native variants:

- **`Icon`** renders inline `<svg>` (web only) → add a `react-native-svg` `.native`
  variant, or a platform split in `@companion/design-system`.
- **`react-native` ambient shim** in the design system is a web substitution; on
  native the real `react-native` types apply — scope the shim to web.
- **Web-only APIs** guarded/kept off the native path: `--wails-draggable` +
  `transitionProperty` styles, `onPointerEnter`, `localStorage`, `window.open` /
  `EventSource` (desktop/web bridges). React Navigation linking already degrades to
  in-memory off the web (see AppShell).
