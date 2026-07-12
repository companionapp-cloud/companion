---
title: Writing & linking notes
group: The basics
groupIcon: notes
groupOrder: 2
order: 2
excerpt: Markdown, wikilinks, tables, and attachments.
badge: The basics
readTime: 3 min read
updated: Jul 2026
related: [your-first-note, using-the-graph]
---

Notes are markdown, and every note can link to anything else in your workspace. Those links are what turn a pile of notes into something you can navigate.

## Markdown as you type

Type `## ` for a heading, `- ` for a bullet, `1. ` for a numbered list, `> ` for a quote, and `` ` `` for code. Bold and italic work the usual way. Nothing needs to be "rendered" — the formatting appears as you write.

The formatting bar at the bottom of the editor covers the rest: bold, italic, strikethrough, inline code, code blocks, quotes, lists, **tables**, and **attach file**.

## Wikilinks

Type `[[` and search. The menu spans notes *and* tasks, each row labelled with its kind, and picking one inserts a chip that keeps showing the live title — and, for a task, its due date and reminder.

![The wikilink menu, searching across notes and tasks](/docs/note-wikilink.png)

Under the hood a link is `[[note:<id>]]` — bound to the thing itself, not to its title. Rename a note and every link to it keeps working.

## Both directions

Links are two-way. Click the **graph** icon in a note's toolbar to see its immediate neighbourhood: what it links to, what links back, and which project it sits in.

![A note's graph panel](/docs/note-graph.png)

## Attachments

Paste or drop a file into a note, or use **Attach file**. Images preview inline, audio gets a player, everything else becomes a file pill. Attachments are stored as first-class objects — they appear in [the graph](/docs/using-the-graph) with the notes that embed them.

> **Tip:** There are no tags and no folders in Companion. Links do the work tags usually do, and [projects](/docs/your-first-project) do the work folders usually do.

## Next steps

See the whole web of connections in [using the graph](/docs/using-the-graph).
