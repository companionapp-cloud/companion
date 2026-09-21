---
title: Exporting notes, tasks & canvases
group: The basics
groupIcon: notes
groupOrder: 2
order: 7
excerpt: Save a note, a task or a canvas as a PDF, an image or a plain file — one at a time, or a whole selection at once.
badge: The basics
readTime: 3 min read
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

## Good to know

- Images embedded in a note are included in the PDF, PNG and HTML. Other embedded files appear by name.
- An image linked from elsewhere on the web is included when its site allows it; otherwise its description stands in.
- Drawings made over a note aren't included yet.
- Exports are always light-themed, whatever theme you use — they're made for paper and for sharing.
- The iPhone, iPad and Android apps don't export yet.
