# Companion — Web (Vite + react-native-web + wasm)

Milestone 2: the hardest binding (PLAN §2, §3.2, §10). The Go core runs in the
browser as WebAssembly, persisting to SQLite entirely offline — no server.

## How it fits together

```
packages/app (shared RN UI)  ──rendered by──▶  react-native-web
        │ uses
        ▼
packages/core-bridge ── createWasmBridge ──▶  core.wasm (Go, GOOS=js)
        │ createWaSqliteDriver                      │ store.Driver (JS-backed)
        ▼                                           ▼
   wa-sqlite  ◀──────── exec/query/close ──────────┘
   (IndexedDB VFS, persistent)
```

- The Go core is compiled to `core.wasm` and exposes the universal
  `invoke(method, json) → json` bridge plus an event stream (see `core/cmd/wasm`).
- Its SQLite driver is **injected from JS**: `createWaSqliteDriver` implements
  `store.Driver` over wa-sqlite. All SQLite calls are serialized through a promise
  chain because wa-sqlite (Asyncify) is not reentrant and the Go core dispatches
  each invoke on its own goroutine.
- The shared UI in `packages/app` is plain React Native, aliased to
  react-native-web by Vite. The exact same components run on native in milestone 3.

### Persistence & headers

Uses wa-sqlite's **IndexedDB** VFS (`IDBBatchAtomicVFS`): persistent across reloads,
main-thread, and no cross-origin-isolation headers required. OPFS (PLAN §3.2/§10) is
the documented upgrade — faster, but needs a dedicated worker + COOP/COEP headers.

## Run it

```bash
make web-assets            # build core.wasm + stage wasm_exec.js into src/wasm/ (gitignored)
npm run dev -w @companion/web
# open http://localhost:5273
```

`make web-assets` must be re-run whenever Go code under `core/` changes.

### Build-time settings

| Variable | Default | What it does |
| --- | --- | --- |
| `EXPO_PUBLIC_PORTAL_URL` | `https://portal.companionapp.cloud` | Where the "Companion Cloud" sign-in points: the portal, and its sync API under `/api`. |

Set it in the shell or an `apps/web/.env` file for `vite build`/`vite dev`, or pass
`--build-arg PORTAL_URL=…` to the Docker build. The same name works for the desktop
frontend and the mobile app (Expo inlines `EXPO_PUBLIC_*` natively).

## Notifications: web push

Reminders fire from an in-tab scheduler while a tab is open. For reminders while the app is
closed, the user turns on **Settings → Notifications**: the web app subscribes through its
service worker (`public/sw.js`) and registers the subscription with the sync server, which pushes
each reminder as it comes due (see `apps/server/README.md` → Web push). From then on this device
shows only the pushed notifications, never its own local ones as well.

iPhone and iPad only allow web push for a web app on the Home Screen (iOS 16.4+). Safari there
offers installing (`IOSPWAInstallBanner` → the `/install` guide); once Companion runs from the
Home Screen and is signed in to sync, `NotificationsPromptBanner` and the guide's installed view
offer turning notifications on.

In production the app must be served over **HTTPS at the root of its origin** (the manifest's
`start_url`, `scope` and `id` are `/`, which is also where iOS launches the Home Screen app), and
`sw.js` + `manifest.webmanifest` must not be cached long-term: `Caddyfile` revalidates both on
every load so a new service worker reaches users on their next visit.

## Build / typecheck

```bash
npm run build -w @companion/web       # vite build (bundles core.wasm + wa-sqlite)
npm run typecheck -w @companion/web
```
