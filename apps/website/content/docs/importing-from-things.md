---
title: Importing from Things 3
group: The basics
groupIcon: notes
groupOrder: 2
order: 7
excerpt: Bring your Inbox, areas and projects over from Things 3 — and choose exactly which.
badge: The basics
readTime: 4 min read
updated: Sep 2026
related: [creating-and-linking-tasks, your-first-project]
---

Companion can read the database Things 3 keeps and bring your work over: the Inbox, your areas and projects, and their headings, notes, checklists, dates, reminders and repeating to-dos. It works in the desktop app, the web app and on your phone — the database is read on your device, so nothing passes through our servers unencrypted, and nothing talks to Things Cloud.

## Open the importer

Go to **Settings › Import** and choose **Import from Things 3…**. In the desktop app you can also use **File › Import › Things 3…**.

## Choose your Things database

Quit Things first, so its latest changes are included.

- **Desktop app (Mac).** Choose **Choose Things database…** — the panel opens in Things' folder. Open **ThingsData**, pick **Things Database.thingsdatabase**, and choose **Choose**.
- **Web.** In Finder, choose **Go › Go to Folder…**, paste `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/` and open the **ThingsData** folder. In Safari, choose **Things Database.thingsdatabase** directly — Safari uploads it as a zip. In other browsers, right-click it, choose **Compress**, and upload the zip.
- **iPhone or iPad.** Things can export its database: in Things, go to **Settings › General › Diagnostics**, enter the code **491348**, and send the database to Files. Open the file it makes in Files to unpack it, compress the folder that appears, and choose the zip.

## Choose what to import

Companion shows what it found:

- **Inbox** — your Inbox, along with any to-dos in no area or project. They land in **Unsorted tasks**.
- **Areas** — ticking an area ticks its projects too; untick any project you don't want. An area's own to-dos (the ones not in a project) become a project named after the area.
- **Projects in no area** — Companion projects always belong to an area, so these go into a new area called **Things**.
- **Include completed to-dos** — also brings Things' Logbook: completed and canceled to-dos, and finished projects, which arrive archived.

Areas and projects come over whole; you can't pick single to-dos.

## How your Things data maps

| In Things | In Companion |
|---|---|
| A project's to-dos and headings | A **To-dos** list in the project, with each heading as a sublist, in Things' order |
| When date | The task's start (This Evening starts at 6pm) |
| Deadline | The task's deadline, at 5pm |
| Reminder | A reminder at the same time |
| Checklist | A checklist in the task's notes |
| Tags | A **Tags:** line in the notes |
| A project's notes and deadline | A note inside the project |
| Repeating to-do | A repeating task, on the same schedule |

Things' own links between to-dos become Companion links.

Two honest caveats. Repeating tasks need [Companion Cloud](/docs/using-our-cloud) or [your own server](/docs/self-hosting) to keep repeating. And Companion can only repeat on a schedule: a Things to-do that repeats "after completion" becomes a fixed schedule, and repeating projects come over once. The importer tells you when this happens.

> **Tip:** Importing is one-way. Import the same area twice and you'll get two copies, so choose carefully the first time.
