# Agenda: planning the day beside its note

The Today view's agenda is where the day gets planned: look up an existing task and give it
time, move and stretch what is there in a quarter-hour grid, and edit calendar events in a modal
without leaving the note.

## 0. The rule

**Time-blocking has no data of its own** (user decision — an `agenda_items` entity was built
and then removed as unnecessary). A task's block is its **start → deadline**; an event's is its
start → end. What fits inside one local day is a block of time in the grid; what doesn't — a
task running Monday to Friday, an event past midnight, a whole day — is an all-day line on every
day it covers. A task with only a deadline, or only a start, is a point on it (drawn 30 minutes).

`fitsInDay` (`calendarLayout.ts`) is that rule; `isAllDay` / `itemDays` (`CalendarAgenda.tsx`)
apply it, so the Calendar tool's week grid and the agenda always agree.

## 1. Core

One change, `core/store/calendar.go`: a task with **no deadline but a start** is now a calendar
point on its start (it used not to appear at all). Spans and deadline points are as before
(PLAN-scheduling.md §3).

## 2. App — `packages/app`

- `Agenda` (`CalendarAgenda.tsx`)
  - `creatable`: the quick-add field (a task due that day, as before) and beside it a search
    button that opens the agenda's palette.
  - `grid` (the desktop/web Today aside): all-day rows, capped and scrolling, over `AgendaGrid`.
    Without it (phones) everything is one list, as before.
  - An event in a writable calendar opens `EventEditorDialog`, from a row or a block.
- `AgendaPalette.tsx` — a minimal command palette (the app palette's card, a size down) opened
  by a click on an empty quarter hour, or by the search button. One input and a time chip:
  - **existing open tasks**, sectioned `unsorted` → `area` → `area › project` in sidebar order
    (memberships read per area with `areas.members {tree}`); a query matches a task's title or
    its project's or area's name, so typing a project lists the project;
  - **New event “…”** (once a writable calendar is connected) — opens `EventEditorDialog` at
    that time with the typed title seeded (`title` on the create target);
  - **New task “…”** — created with that time as its start → deadline.
  ↑↓ / ⏎ / esc; ⇧⏎ adds a task and keeps the palette open, handing the next pick the time after.
  A click starts exactly on the quarter clicked and runs half an hour, or up to whatever comes
  next; the search button uses the next free half hour (from now today, from 9:00 otherwise).
  A picked task gets `startAt` + `dueAt` — **unless it is due after this day**: then only its
  start moves here, its deadline is kept, and it reads all day until then.
- `AgendaGrid.tsx` — midnight to midnight, a 14px row per quarter hour (hours firm, halves
  light, quarters dotted). Blocks drag and stretch in 15-minute steps with a live time preview;
  concurrent ones share the column in lanes (shared with the week grid). Clicking an empty
  quarter opens the palette. Movable: open tasks, and one-off events in a writable calendar.
- `taskBlockPatch` — what a dropped task block writes: a task with both dates, or one just
  stretched, takes `startAt` + `dueAt`; a point only moved keeps being a point on the date it
  had. The week grid's drag uses it too (it used to write `dueAt` alone).
- `TodayScreen.tsx` — the aside no longer scrolls as a whole (the grid does), and its sync
  line is gone: the shell's status bar already says the same thing.

## 3. Consequences worth knowing

- Stretching a deadline-only task gives it a start; moving a task's block moves its deadline,
  and any reminders counted back from it.
- A task that starts and is due on the same day is now a timed block everywhere, where it used
  to be an all-day line.

## 4. Not done

- Dragging an all-day row into the grid, and resizing task blocks in the week grid.
- The native app shows start-only tasks once its core is rebuilt (`make core-ios` / `core-android`).
