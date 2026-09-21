---
title: Exporting, Git sync & importing files
group: The basics
groupIcon: notes
groupOrder: 2
order: 7
excerpt: Save anything as a PDF, an image or a plain file; keep a folder up to date; sync your workspace with a Git repository; bring Markdown files in.
badge: The basics
readTime: 7 min read
updated: Sep 2026
related: [linking-notes, your-first-canvas, creating-and-linking-tasks]
---

Anything you make in Companion can leave it. A note or a task exports as a **PDF**, a **PNG**, **HTML**, plain **Text** or **Markdown**; a canvas, being a picture, exports as a **PDF** or a **PNG**. Exporting works in the desktop app and the web app, and happens on your device — nothing is uploaded to make the file.

## Export what you're looking at

Open the note, task or canvas and choose the **Export** button (the downward arrow) in the bar above it, then pick a format.

In the desktop app you can also use **File › Export** and pick the format there. The menu follows what's on screen: with a canvas open it offers PDF and PNG; with a note or a task, all five. A note or task popped out into its own window exports from that window.

- **Desktop app.** A save panel opens on the item's title — choose where the file goes.
- **Web.** The file downloads.

## Export several at once

Select more than one note, task or canvas in a list — **⌘-click** (Ctrl-click on Windows and Linux) to add items one by one, **⇧-click** to take a range — and choose **Export…** in the bar above the selection. **File › Export** does the same while a selection is active.

Each item becomes its own file, named after its title.

- **Desktop app.** Choose a folder and the files are written into it. A file that's already there is never replaced — the new one is named "Title 2" instead.
- **Web.** The files download together as **Companion Export.zip**.

## What each format holds

- **PDF** — pages of A4 or US Letter (whichever your region uses), with the text selectable and searchable and links clickable. A canvas is a single page cut to the board's size.
- **PNG** — one image: a note or task as a single tall sheet, a canvas at its own size.
- **HTML** — a standalone page with its styling and images inside it, so it opens anywhere.
- **Text** — the words alone: lists keep their bullets, numbers and checkboxes; tables are tab-separated.
- **Markdown** — your note as you wrote it, under a block of YAML frontmatter holding everything that isn't the text itself (see below). Links to other notes and tasks become `[[Their title]]`, and an embedded file becomes `![[its filename]]`.

A task's PDF, PNG, HTML and Text exports start with its details — status, start date, deadline, repeat, reminders, and the project or area it's filed in — followed by its notes.

### Markdown frontmatter

A Markdown export opens with frontmatter, the way Obsidian and most publishing tools expect, so the body is only what you wrote:

```md
---
title: Ship the export feature
status: open
start: 2026-09-28
deadline: 2026-10-01
repeat: Every week
reminders:
  - "1 day before"
created: 2026-09-21T02:50:56.74Z
updated: 2026-09-21T02:50:56.74Z
filed_in: Website relaunch
---

Your notes on the task…
```

- **Notes** carry `title`, `date` (a daily note's day), `created`, `updated` and `filed_in`.
- **Tasks** carry `title`, `status` (`open`, `done` or `cancelled`), `start` (a date, or `someday`), `deadline`, `repeat`, `reminders`, `completed`, `created`, `updated` and `filed_in`.
- A note or task with an [object type](/docs/object-types) adds `type` and one line per property, under the property's own key. A property that links to another note or task reads as its title.

Dates with no time are written as plain dates (`2026-10-01`); anything with a time is a full timestamp. Fields that are empty are left out.

PDFs and PNGs carry the Companion mark in a footer on each page. HTML, Text and Markdown files are yours plain.

## Keep a folder up to date

One-off exports are for sharing. To keep a standing copy of your whole workspace outside Companion, schedule a filesystem export in the desktop app under **Settings › Export** — or from **File › Export › Schedule Filesystem Exports…**.

Notes and tasks are written as Markdown with the frontmatter above (plus an `id` and a `kind`, which is how Companion recognises its own files again), canvases as JSON in the open [JSON Canvas](https://jsoncanvas.org) format, filed the way your workspace is:

```
Notes/                          unfiled notes
Tasks/
Canvases/
Attachments/                    the images and files your notes and canvases embed
Areas/Work/Notes/               filed straight in the Work area
Areas/Work/Website relaunch/    a project: Notes/, Tasks/, Canvases/
```

An embedded file is written once, however many notes use it, and a note points at it by path — `![[Attachments/photo.png]]` — which Obsidian and most Markdown tools follow. A file that hasn't finished downloading to this computer yet is simply written on a later run.

Put the folder in iCloud Drive, Dropbox or another synced drive and you have a copy off your computer. Choose an empty folder: Companion replaces files it finds with the same names, and only ever deletes files it wrote itself.

Choose how often: **On changes** (about a minute after you stop editing), **Hourly**, **Daily**, **Weekly**, or **Manually** with **Export now**. Renaming or moving something renames or moves its file; trashing it removes the file.

A folder export is **one-way**: editing the files doesn't change anything in Companion. A folder can't say what was changed on purpose or deleted on purpose, so Companion never reads one back on its own. For two-way, use Git.

## Sync with a Git repository

Under **Settings › Sync › Git** (or **File › Export › Git Sync…**) Companion keeps the same files in a Git repository — **both ways**. What you change in Companion is committed and pushed; what changes in the repository — edits in another editor, on another machine, by a script — comes back in.

Setting it up asks three things:

1. **Where the repository is** — GitHub, GitLab, Bitbucket, or another server.
2. **How to sign in** — an **access token**, an **SSH key**, or a **username and password**. The form then shows just what that needs, with the steps for your host. For SSH, Companion makes the key itself and shows you the public half to add as a deploy key; you never handle the private one.
3. **The repository** — `you/companion-notes` on the big hosts, or its address anywhere else. Use a repository just for this, ideally empty and private.

How it behaves:

- Companion only touches its own folders (`Notes`, `Tasks`, `Canvases`, `Attachments`, `Areas`). A README or anything else you keep in the repository is left alone.
- Attachments travel both ways. Drop a picture into `Attachments` and embed it from a note, and it arrives in Companion; replace a file there and every note that used the old one uses the new. Files over 50 MB stay out of the repository — Git hosts refuse them, and a repository never forgets one.
- A file you add by hand becomes a note — or a task, if it sits in a `Tasks` folder or says `kind: task`. Companion writes its `id` into it on the next sync.
- **Deleting a file moves its item to the Trash**, where it stays recoverable for 30 days. If a large share of the files vanish at once, the sync pauses and asks before doing anything.
- If the same note changed in both places, the repository's version is taken and Companion's is kept beside it as a "conflicted copy" — the same way syncing between devices resolves it.
- To clear a field from a file, delete its line (or leave it empty). A line that was never there changes nothing.
- A file Companion can't read — broken frontmatter, say — is left exactly as it is, and reported.
- Companion always syncs with its own server first, so it never pushes stale work, and its commits go directly on top of the repository's latest — it never force-pushes.

**One device runs each Git sync.** The repository and its sign-in are synced to your other devices — end-to-end encrypted, so the Companion server can't read them — and any of them can take the sync over with **Sync from this computer instead**. The new device works out where things stand from the repository itself: files left behind by things you've since renamed, moved or deleted are tidied away, anything newer in Companion is written out, and edits made in the repository still come in. (If your account isn't end-to-end encrypted, the sign-in stays on the device you typed it into.) Git sync runs in the desktop app, while it's open or in the menu bar.

The repository holds plain, readable files, so it sits outside Companion's end-to-end encryption: anyone who can read it can read your notes, and anyone who can write to it can change them.

## Import Markdown files

**Settings › Import › Import Markdown files…** (or **File › Import › Markdown Files…**) brings in a folder once: a Companion export, an Obsidian vault, or any folder of notes. It shows what it found before writing anything.

- Each Markdown file becomes a note — or a task, per its folder or `kind`. A file with no frontmatter is a note named after the file.
- `[[Links]]` between the files are kept, and an `Areas/…` layout files things into areas and projects, creating them as needed.
- Images and files the notes embed come along — `![[photo.png]]` or plain `![](images/photo.png)` — wherever in the folder they sit. Files no note uses are left behind.
- It only adds. Files that came from this workspace (they carry its ids) are skipped unless you tick **Update notes and tasks that are already in Companion**. Nothing is ever deleted.

## Good to know

- In a one-off export, images embedded in a note are included in the PDF, PNG and HTML; other embedded files appear by name.
- An image linked from elsewhere on the web is included when its site allows it; otherwise its description stands in.
- Drawings made over a note aren't included yet.
- Exports are always light-themed, whatever theme you use — they're made for paper and for sharing.
- The iPhone, iPad and Android apps don't export yet.
