---
title: Creating & linking tasks
group: The basics
groupIcon: notes
groupOrder: 2
order: 5
excerpt: Every way to make a task, how reminders and repeats work, and how tasks connect to the rest of your workspace.
badge: The basics
readTime: 4 min read
updated: Sep 2026
related: [your-first-task, linking-notes]
---

[Your first task](/docs/your-first-task) covers the basics: type a title, press Enter, give it a date. This page is the rest — where tasks come from, how reminders and repeats behave, and how a task connects to your notes and projects.

## Five ways to make a task

- **The Tasks list.** Type into **Add a task, press Enter**. The task lands in **Unsorted tasks** until you file it.
- **Inside a project.** A project's **Tasks** section has the same field, and anything added there is filed in that project from the start.
- **Quick capture.** On the desktop app, [quick capture](/docs/capture-and-focus) takes a task, with a deadline and a reminder, without leaving what you're doing.
- **Chat.** Ask the AI to make tasks from a conversation and it writes them into your list — see [chat into tasks](/docs/chat-into-tasks).
- **From a link.** Type `[[Call the plumber]]` in a note and close the brackets without picking a result. Double-click that unresolved link and choose **Create task**: the task is made with that title, and the text becomes a real link to it.

## Start, deadline, reminders, repeats

A task has two dates, both optional. **Add start** is when you mean to begin; **Add deadline** is when it has to be done. Both take plain language — "next friday", "tomorrow 3pm" — and echo back what they understood. The one-click presets start a task at 9am and set a deadline for 5pm.

**Add reminder** takes as many reminders as you need. Once a task has a deadline, **Day before**, **Few days before** (three), **Week before**, **Few weeks before** (two), **Month before**, and **At deadline** each add one with a click, counted back from the deadline — move the deadline and they move with it. You can also type one — "2 days before", "an hour before", or a time like "tomorrow 9am" — or pick **In 1 hour**, **Tonight 6pm**, or **Tomorrow 9am**. When a reminder comes due, it appears in the notifications bell in the top right and Companion fires a system notification. Click it in the bell to open the task.

With no reminders set, a task with a deadline nudges you once, when it's due. Adding reminders replaces that nudge with yours; add **At deadline** if you want both.

Two honest caveats. On the web, notifications only fire while a Companion tab is open — the desktop app is what makes them reliable. And reminders exist for tasks only; notes and events don't nudge you.

> **Tip:** Missed nudges aren't lost. Anything that fired while you were away is waiting in the notifications feed.

**Repeat** takes a cadence — "every other tuesday", or a preset like **Every weekday**. Occurrences are generated on your sync server, so repeats need [Companion Cloud](/docs/using-our-cloud) or [your own server](/docs/self-hosting) connected; without one, the editor tells you **Repeats need a connected sync server** rather than failing quietly. The schedule follows the deadline, or the start if there's no deadline. Each occurrence keeps the original's projects, its start and reminders move along with it, and it appears as soon as it starts or its first reminder is due.

## Linking tasks and notes

In any note, type `[[` and pick a task. The chip shows whether the task is done, plus its deadline and reminders, and stays current as the task changes. Click a chip to select it; click again to open the task in a new tab.

It works from the other side too: a task's notes field accepts `[[`, so a task can link out.

## Projects and lists

Click the **folder** icon in a task's toolbar to open **Move to** and pick where it lives: a project, or an [area](/docs/your-first-project) directly. A task lives in one place, so picking a new one moves it. You can also drag a task onto an area or a project in the sidebar, or select several and choose **Move to…**.

Inside a project, **Lists** put tasks in an order you choose. Add one with **New list**, drag rows into priority order, and use **New heading** to break a list into sublists. **Add existing task** pulls in tasks already in the project.

## Where linked tasks show up

- **The graph.** Every task is a node, joined to what it links to and the projects it's in. The **graph** icon in a task's toolbar shows just that task's neighbourhood; **Graph settings** in [the full graph](/docs/using-the-graph) can hide **Complete** or **Incomplete** tasks.
- **Today.** A task appears in the agenda on [Today](/docs/today-home-base) for the day it's due.
- **The calendar.** Tasks sit on their deadline beside your events. In the week view, drag one to another day or time to reschedule it, in 15-minute steps. See [calendars](/docs/calendars).

## Object types

A task can carry an [object type](/docs/object-types), just like a note: click **+ add type** in the row of chips under the title, then fill in its fields in the metadata panel. Typed tasks take the type's colour and icon in the graph.

## Next steps

Read [writing & linking notes](/docs/linking-notes) for the other half of the link, or gather tasks into [your first project](/docs/your-first-project).
