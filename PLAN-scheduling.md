# Scheduling, Someday & the Logbook — Implementation Plan

Projects get a task's scheduling shape — a start, a deadline, completion, repeat — and both
tasks and projects gain **Someday** in place of a start date. The task lists grow the schedule
views that follow from that (Anytime, Someday; Upcoming and Overdue regrouped by start date), the
calendars show anything with a start *and* a deadline as an all-day span, and a new **Logbook**
tool keeps everything finished, by the day it was finished.

This follows `PLAN.md` (it amends §6.4 tasks, §6.6 projects and §6.7 calendar): business logic
in the Go core, one JSON-over-`invoke` API, row-level sync, shared UI in `packages/app`.

---

## 0. Decisions up front

| Decision | Choice | Why |
|---|---|---|
| Someday | A **`someday` flag** on `tasks` and `projects`, exclusive with `start_at` — core clears one when it sets the other. A deadline may remain | Asked for as "Someday as the start date": it sits with the start presets in the editor and reads in the start chip. A flag (not a sentinel date) keeps every date comparison honest. |
| Where Someday things show | A Someday **task** shows only under the Someday filter. A Someday **project** is off the sidebar and the mobile home list, and listed — labelled "Someday", after the active ones — only on its area's overview | Asked for. (In the "Unsorted" bucket, which has no overview, a Someday project stays visible: there is nowhere else to find it.) |
| Tasks in a Someday project | **Filed away with it** (asked): out of every list but Someday — and the project's own task list, which shows them normally | Things' behaviour. `projects.somedayTaskIds` gives the task lists the set. |
| Project completion | **`completed_at`**; completing also sets `archived_at`, reopening clears both | Completed = hidden everywhere but the Logbook. `archived_at` already keeps a project out of the graph (the `graph_nodes` view and `links.go`), so the graph needs no change. |
| Completing with open tasks | **Confirm, then complete them** (asked): `projects.update {completed, completeTasks}` finishes every open member task in the same batch. Reopening the project does not reopen them | The whole project lands in the Logbook together. Repeating seeds are definitions, not to-dos, and are left alone. |
| What a repeating project makes | **A fresh copy** (asked) — a chain of ordinary projects, not a seed + occurrences. The newest copy carries the repeat; spawning moves it on | The finished copy stays in the Logbook with its done tasks. No hidden template entity: the next copy is a copy of the *latest* one, so a task added this week is there next week. |
| What a copy takes | Plain tasks are **copied** (reset to open, dates shifted; cancelled ones dropped) and the project's lists rebuilt around them. Everything else filed in it — notes, canvases, calendars, repeating-task seeds — is **re-filed into the new copy**. Task occurrences already made stay put | An item lives in one container (PLAN-areas.md), so reference material can't be in both; it follows the live project. **Unconfirmed default** — see §7. |
| Who spawns | **The server**, like task occurrences: on the minute sweep, and at once when a repeating project is pushed | One generator, so two devices can never each make a copy. It copies ciphertext verbatim — field encryption is bound to entity type + field, never the row id. No server ⇒ no repeats, exactly like tasks. |
| Two kinds of repeat | `repeat_after` ("P3D", "P2W", "P1M", "P1Y": *N units after completion*) **or** `repeat_rule` (an RRULE: every day / week / month, optional `UNTIL`) — never both | Asked for. The RRULE reuses the task parser; the after-completion interval gets years, which a reminder lead doesn't have. |
| Idempotent spawning | Every id is derived: `NextProjectID(prev, turn)`, `CopiedTaskID`, `CopiedListID`, `CopiedHeadingID`; inserts are `ON CONFLICT DO NOTHING` | A retried spawn converges on the same rows. A copy the user deleted is never resurrected; handing the repeat back to an old copy spawns again (the turn is part of the id). |
| Spans on the calendar | An **open** task or project with a start **and** a deadline is one `span` item (`startsAt`/`endsAt` = those instants, `allDay: false`); clients place it in the all-day band of every *local* day it covers | Asked for. `allDay` promises UTC-midnight date markers; which days an instant falls on depends on the viewer's timezone, which core doesn't know — so the client does the placing (`itemDays`). Done/cancelled tasks and completed projects fall back to a point on the deadline / drop out. |
| Overdue | Deadline passed — or, with no deadline, start *date* passed (a start earlier today isn't "passed") | Asked for. |
| Upcoming | Scheduled (start or deadline) and not overdue — including a task under way (start passed, deadline ahead), which groups under Today | So the four schedule views partition the open, non-Someday tasks: Anytime / Upcoming / Overdue. |
| Date groups | By **start date** (else deadline): Today, Tomorrow/Yesterday, each other day of this month, each other month of this year, each other year — nearest first. **Upcoming always lays out Today, Tomorrow and every remaining day of the month**, empty or not, so it has no empty state | Asked for. One helper (`groupByDate`, `fillMonth`) serves Upcoming, Overdue and the Logbook. |
| Adding from a schedule view | A task typed into **Someday** is filed under Someday; into **Upcoming**, it starts tomorrow; into **Overdue**, it starts today (9:00, like the editor's presets) — `newTaskDefaults` | Asked for. A new task lands in the view it was typed into — except Overdue, where nothing new belongs, so it goes to today (and shows under Upcoming → Today). |
| Logbook | A tool above the Trash. **Client-side**: done tasks (`completedAt`) + completed projects, grouped by completion day, paged 200 at a time | `tasks.list` already returns done tasks; nothing new crosses the bridge. With a pointer it is a **split view** — the picked task or project opens beside the list, never navigating away (asked). On a phone a row pushes onto the stack. Its task rows multiselect like the tasks list's (asked); project rows stay single-select, as repeating definitions do, because a selection is one kind of thing. |

---

## 1. Data model

### 1.1 Client SQLite — `core/store/migrations/0027_project_scheduling.sql`

```sql
ALTER TABLE tasks    ADD COLUMN someday INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN start_at TEXT;
ALTER TABLE projects ADD COLUMN due_at TEXT;
ALTER TABLE projects ADD COLUMN someday INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN completed_at TEXT;
ALTER TABLE projects ADD COLUMN repeat_rule TEXT;
ALTER TABLE projects ADD COLUMN repeat_after TEXT;
```

`domain.Task` gains `Someday`; `domain.Project` gains `StartAt`, `DueAt`, `Someday`,
`CompletedAt`, `RepeatRule`, `RepeatAfter`. Both `Validate` a Someday row has no start; a
project validates its rule / interval and that it has at most one. All of it counts in
`MeaningfulDiff`. Update inputs follow the task convention (`startAt` + `clearStartAt`, …);
projects add `someday`, `completed`, `repeatRule` / `repeatAfter` / `clearRepeat`.

All of it is **plaintext** on the wire: scheduling metadata the server times repeats from, like
a task's dates (`core/crypto/rows.go`).

`Store.Sidebar()` drops completed projects and flags Someday ones; `ListForAreaTree` leaves a
completed project's content out of its area's roll-up; `CountForArea` ignores completed
projects, so an area whose projects are all finished can be deleted.

### 1.2 Server — `packages/syncserver`

The same columns (`db.go`: `CREATE TABLE` plus idempotent `ALTER`s) through the task and
project handlers; the project handler validates the repeat definition on write.

---

## 2. Repeating projects — `core/domain/projectrepeat.go`, `packages/syncserver/project_repeat.go`

`nextProjectTurn` decides whether a copy is due and where it lands:

- **After completion** — once `completed_at` is set: `NextAfterCompletion` = the interval past
  the completion, snapped back to the old anchor's time-of-day (a project that starts at 9:00
  keeps starting at 9:00 whatever hour it was ticked off).
- **Scheduled** — `NextScheduled(rule, anchor, now)`: the latest occurrence ≤ now that is after
  the current copy's anchor (start, else deadline, else creation) — so a server that was down a
  week makes one copy, not seven. A **deadline-only** project is *eager*: its next copy is made
  as soon as the current deadline passes, since a copy is only useful before its deadline.

`spawnProject`, in one transaction: insert the copy (open, dates shifted, repeat carried on) →
clear the old copy's repeat → copy plain tasks + memberships → copy lists (headings as they are,
task items pointed at the copies) → re-file the rest (the old membership tombstoned *before*
the new one is written, so a client applying the pull in order never sees an item filed twice).
The chain ends when the rule's `UNTIL` passes, or when the newest copy is deleted.

---

## 3. Calendar — `core/store/calendar.go`

`rangeItems` selects task spans by overlap (`start_at < to AND due_at >= from`) and every other
dated task as a point on its deadline, then open projects with both dates as `ItemProject`
spans. A project's own calendar (`RangeForProject`) includes the project itself.

Clients: `itemDays(item)` / `isAllDay(item)` (`CalendarAgenda.tsx`). The week grid buckets a
span into every day it covers; the day agenda lists all-day lines first; the hover card reads
"Thu, Oct 1 – Fri, Oct 9"; a project item opens the project.

---

## 4. App — `packages/app`

- `taskSchedule.ts` — the schedule predicates, `filterBySchedule` / `withoutSomeday`, and
  `groupByDate`. `TaskGroups.tsx` — `DateGroupHeading`, `ScheduledTasks`.
- `TasksProvider` — `TaskFilter` = Unsorted / All / Anytime / Upcoming / Overdue / Someday;
  `somedayIds`; the sidebar badge ignores Someday tasks.
- Task lists (workspace, project/area, mobile web, native) — the six filters, grouped under
  Upcoming and Overdue. On phones the segmented filter scrolls sideways.
- `TaskEditor` — a "Someday" chip with the start presets; the start chip reads "someday". A row
  with no deadline whose start date has passed reads "started Sep 13" in danger.
- `ProjectSchedule.tsx` — a project's start / deadline / repeat chips and its Complete button,
  under its name on the overview (and on the native settings screen). A completed project shows
  when it was finished, with Reopen, and its page looks back at its completed tasks.
- `ProjectsProvider` — `projects` is the open ones (so no picker offers a finished project),
  `completedProjects`, `projectById` (either).
- Multiselect (`MultiSelectProvider`) gains the `canvas` kind: both canvases lists (root and a
  project's) take cmd/shift-click, with Move to… / Delete in the shared bar and the first board on
  the selection stack. `useOptionalMultiSelect` lets lists the mobile shells also host opt out.
- `LogbookScreen.tsx` + the `logbook` view id, tool, icon and routes in all three shells. A new
  tool slots into a saved tool order just ahead of the tool it precedes by default.

---

## 5. Importer — `core/importer/things`

Things' Someday (no start date) maps to the flag on to-dos and projects; a project's start and
deadline become real fields (they used to be written into its note); a finished project keeps
its completion date, so it lands in the Logbook on the right day.

A repeating project (`projectrepeat.go`) is a hidden template plus the copies Things made of it.
The **newest open copy carries the repeat**; with no open copy, the **template is imported as
the upcoming copy** — starting on its next date, holding the template's to-dos. "After
completion" maps exactly onto `repeat_after`. A schedule becomes an RRULE *moved onto the days
the project's anchor falls on*, because the server reads the rule from that anchor in UTC: by
Things' start offset (a copy that starts 2 days before each Friday repeats on Wednesdays) and by
the UTC date of a local-midnight start. "Ends after N" becomes `UNTIL` the day of the last copy
(a rule read afresh from each copy can't count down). A schedule that can't be moved (an n-th
weekday, a yearly date pushed into another month) imports the copy without its repeat, warned;
an after-completion repeat that ends in Things never ends here, warned.

---

## 6. Tests

`core/store/scheduling_test.go` (Someday exclusivity; project fields through Update / Apply /
diff / sidebar; calendar spans), `core/bridge/projects_test.go` (complete-with-tasks),
`packages/syncserver/project_repeat_test.go` (after completion — tasks, lists, re-filing,
idempotency; on a schedule with an end date; deadline-only).

---

## 7. Open questions

- **What a copy takes** was never confirmed (the answer given contradicted the "fresh copy"
  choice): notes/canvases/calendars *move* to the newest copy. The alternative — they stay with
  the finished one — is a small change in `spawnProject` step 5.
- "After completion" exists for projects only; tasks keep their RRULE repeats.
- A repeating-task seed inside a completed project keeps generating occurrences there.
- Old clients push full rows: one that predates these columns will clear them on its next edit
  of the same row (the standing cost of row-level sync; same as every earlier column).
