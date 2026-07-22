# Companion Watch app

A thin watchOS companion to the phone app, added via [`@bacons/apple-targets`] without
ejecting from Expo's Continuous Native Generation. The phone stays the source of truth; the
watch navigates the tasks it pushes and can quick-add new ones.

## Screens

`RootView` (a `NavigationStack` list):

- **Add Task** — type/dictate a title and pick Today/Tomorrow. A date written into the title
  ("call Bob Friday 3pm") is **auto-detected** by the phone and, while the phone is reachable,
  previewed live under the title; on submit the phone re-parses authoritatively either way.
- **Today** / **Upcoming** / **Overdue** — the three date buckets, each a `TaskListView`.
- **Calendar** → upcoming calendar events (today + the next week).
- **Projects** → a project → its open tasks.

`WatchStore` (an `ObservableObject` + `WCSessionDelegate`) owns the snapshot and the session.

## Golden rule

Edit watch source **only in this directory** (`apps/mobile/targets/watch/`). It shows up in
Xcode as the virtual `expo:targets` group and is re-linked into the disposable `ios/` project
on every `npx expo prebuild`. Anything you change elsewhere in Xcode is overwritten on the
next prebuild.

Committed source: `index.swift`, `content.swift`, `Screens.swift`, `WatchStore.swift`,
`expo-target.config.js`. `Assets.xcassets/` and `Info.plist` are regenerated from config each
prebuild and are gitignored (see `apps/mobile/.gitignore`).

## Data sharing — WCSession + App Groups

**Key fact:** App Groups do **not** cross devices. An App Group shares a container between apps
on the *same* device; the iPhone and the Apple Watch are separate devices, each with its own
group container. So App Groups alone can never move phone data to the watch — the watch would
read an empty suite. **WatchConnectivity (`WCSession`) is the actual phone→watch transport.**

Two roles, kept distinct:

- **`WCSession` — cross-device, both directions.** Phone→watch, the phone sends the snapshot two
  ways: *application context* (durable — coalesced to latest, replayed when the watch next
  wakes; the primary path on real devices) **and**, when the watch is reachable, a live
  `sendMessage` (immediate — and the **only** path the Simulator actually delivers). Watch→phone,
  the watch sends quick-adds and a "request snapshot on launch" the same way (`sendMessage` when
  reachable, `transferUserInfo` queued otherwise).
- **App Group `group.cloud.companion.app` — same-device caches.** On the *watch* it holds the
  last received snapshot for cold start (+ future complications). On the *phone* it mirrors the
  Today list for a future iOS home-screen widget. The id must stay identical in the two
  entitlement declarations (`app.json`, `expo-target.config.js`) and the Swift `kAppGroup`.

**Send (phone, TS):** `apps/mobile/src/watch.ts` builds the snapshot; `WatchTasksBridge`
(mounted in `App.tsx` inside `TasksProvider` + `ProjectsProvider`) pushes it via
`modules/watch-bridge` (`updateWatchContext`) on every task/project change and whenever the
watch requests a refresh. It also creates a task when the watch sends `createTask`.

**Receive (watch, Swift):** `WatchStore` is a `WCSessionDelegate`; on each received context/
message it caches to the App Group and publishes to the UI. On cold start it shows the cached
value and asks the phone for a fresh one.

### Snapshot contract

Application context / message payload: `{ today, upcoming, overdue: [task], projects: [{ id,
name, tasks: [task] }], events: [event], meta }`. Buckets are disjoint by day boundary (overdue
= before today, today = today, upcoming = after today; undated tasks appear only under their
projects). Everything is flat scalars — the phone pre-formats labels and pre-sorts, so the watch
never parses a date:

| Field   | Shape                                                                            |
|---------|----------------------------------------------------------------------------------|
| `task`  | `{ id, title, dueLabel, overdue: 0\|1, sortKey: ms }`                             |
| `event` | `{ id, title, whenLabel, startKey: ms, allDay: 0\|1 }` (calendar kind, ≤7 days)  |
| `meta`  | `{ updatedAt, todayCount, upcomingCount, overdueCount, eventCount }`             |

Lists are capped (≤50); `meta.*Count` carries the true total so a list can show "+N more".

Watch→phone messages:
- `{ type: "requestSnapshot" }` — fire-and-forget; phone re-pushes the snapshot.
- `{ type: "createTask", title, due: "today"|"tomorrow" }` — phone auto-detects a date in the
  title (that wins), else uses `due`.
- `{ type: "parseDate", title }` — **reply-expecting** (`sendMessage` with a reply handler);
  the phone replies `{ dueLabel }` (or `{}`) for the live Add-Task preview. Requires the phone
  reachable, so it degrades to no-preview when it isn't; the submit path is unaffected.

> **Gotcha (simulator):** `updateApplicationContext`/`transferUserInfo` are frequently **not
> delivered between paired simulators** — only live `sendMessage` (while both apps are
> foreground and reachable) is. That's why the phone sends both. On real devices all paths work.

## Before shipping

- **`ios.appleTeamId`** is required in `app.json` for the watch target to codesign (App Groups
  need a real team). Prebuild warns until it's set. Find it in Xcode → Signing & Capabilities,
  or the Apple Developer portal. Left out here because it's account-specific.
- Watch + main app **build/version numbers must match** for App Store submission. The plugin
  stamps the watch `MARKETING_VERSION` at `1.0`; align it with `app.json` → `expo.version`.
- Do **not** add `expo-updates` to this target.

## Build

```bash
cd apps/mobile
CI=1 npx expo prebuild -p ios --clean --no-install   # regenerate ios/ + relink targets/
make ios-run                                          # or: npm run ios -w @companion/mobile
```

In Xcode, pick the watch scheme + a paired watchOS simulator to run the watch app directly.

[`@bacons/apple-targets`]: https://github.com/EvanBacon/expo-apple-targets
