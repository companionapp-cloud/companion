---
title: Companion in your terminal
group: The basics
groupIcon: notes
groupOrder: 2
order: 8
excerpt: Write today's note, check your week and walk your graph without leaving the terminal, and capture from Rex's palette.
badge: The basics
readTime: 4 min read
updated: Nov 2026
related: [terminal-agents, today-home-base, using-the-graph]
---

If you spend your day in a terminal, Companion comes with you. `companion tui` opens your workspace in a terminal window. It has today's note, your calendar, notes, tasks, canvases and the graph. `companion new` saves a note or task in one line, and the [Rex](#rex) plugin puts both in Rex's command palette.

They all work on the workspace in the Companion app on the same Mac. Changes show up in the app straight away, and sync to your other devices as usual.

## Before you start

You need the desktop app on a Mac, installed with Homebrew (see [Getting the apps](/docs/getting-the-apps)). Homebrew also puts the `companion` command on your `PATH`. If you installed Companion before version 0.31, run this once:

```bash
brew update && brew upgrade --cask companionapp-cloud/tap/companion
```

Then, in Companion, open **Settings → AI** and, under **Terminal agents**, tick **Let terminal agents use Companion**. That one switch lets the terminal reach your workspace, for these commands and for [Claude Code and Codex](/docs/terminal-agents). To create and edit from the terminal, tick **Write tools** as well. Without it, everything here is read-only.

Companion doesn't need to be open. If it isn't running, the first command starts it in the menu bar, without a window.

## The terminal UI

```bash
companion tui
```

It opens on today. To start somewhere else, name the tab: `companion tui calendar`, or `notes`, `tasks`, `canvases` or `graph`.

Six tabs run along the top. Press **1**–**6** to jump to one, or **Tab** and **Shift+Tab** to step through them. The bottom line always lists the keys the current tab takes. **q** quits, and **Ctrl+C** quits from anywhere, saving first.

The TUI keeps itself up to date. Edit a note in the app, or on your phone once it syncs, and the terminal shows the change without a refresh.

### Today

![The Today tab: today's daily note open in an editor, with a Focus list and a Notes section](/docs/tui-today.png)

Today's [daily note](/docs/today-home-base), ready to type into. It's the same note as the one on Today in the app. If there isn't one yet, typing creates it. It saves as you type.

The editor has the keyboard, so letters type rather than switch tabs. Press **Esc** to stop editing, then use the tab keys. **Enter** goes back to editing.

### Calendar

![The Calendar tab in week view: meetings, due tasks and the daily note for each day from Monday to Sunday](/docs/tui-calendar.png)

Your agenda: events from your [calendars](/docs/calendars), tasks with a deadline, and daily notes, in time order. **←** and **→** move a day at a time, **w** switches between a day and a week, and **t** comes back to today.

### Notes

![The Notes tab: a list of notes on the left and the selected note rendered as Markdown on the right](/docs/tui-notes.png)

Every note, most recently edited first, with the selected one rendered on the right. Links show as the titles they point to. Press **/** to search titles and text, **↑** **↓** to move, and **Enter** to edit the note's Markdown. **Esc** saves and closes it.

### Tasks

![The Tasks tab: open tasks in due order, one overdue, with their deadlines](/docs/tui-tasks.png)

Open tasks, soonest deadline first, with overdue ones marked.

| Key | Does |
|---|---|
| **x** | Mark done, or reopen a done task |
| **d** | Set the deadline, in plain words: `tomorrow 5pm`, `fri`, `next week` |
| **n** | New task |
| **a** | Show or hide finished tasks |

### Canvases

![A canvas shown as an outline: its cards in board order, then the arrows between them with their labels](/docs/tui-canvas.png)

A terminal can't draw a [canvas](/docs/your-first-canvas), so it reads you one. Pick a canvas and press **Enter** to see its cards, top to bottom and left to right as they sit on the board, then every arrow between them, with its label. **Esc** goes back to the list.

### Graph

![The Graph tab centred on a note, listing the tasks it links to and the notes, canvas and project that link to it](/docs/tui-graph.png)

The [graph](/docs/using-the-graph), one step at a time. Press **/** and type to find a note, task, project or canvas. The tab then lists everything connected to it: **→** for what it links to, **←** for what links to it, and how. **Enter** follows a connection, and **b** steps back.

You can jump here from the other tabs too. **g** on a note, a task, today's note or an open canvas shows its connections.

## Quick capture: `companion new`

One line saves a note or a task, from a terminal or a script:

```bash
companion new note "Standup notes" --body "- Pricing copy is with legal"
companion new task "Call Sam" --due "fri 3pm"
```

Tasks also take `--start`. Dates are plain words, read the same way as in the app. If a date doesn't make sense, nothing is created and the command says so. Add `--json` to get the new item's id back.

## Rex

Rex users can have all of this in Rex's command palette. Install the plugin once:

```bash
companion rex install && rex config reload
```

That writes the plugin to `~/.config/rex/plugins/companion/init.lua` and loads it from your Rex config. Run it again any time to update it. Search the palette for **Companion:**

| Action | Does |
|---|---|
| **Companion: Open** | Opens the terminal UI in a new tab |
| **Companion: Today's Note** | Opens today's note in a pane beside the one you're in |
| **Companion: Calendar**, **Notes**, **Tasks**, **Canvases**, **Graph** | Open that tab in a pane beside |
| **Companion: New Note…** | Asks for a title, then the first lines, and saves the note |
| **Companion: New Task…** | Asks for a title, then a deadline (optional). If the date doesn't read, it asks again instead of dropping the task |

The actions run Companion on your Mac, so in a Rex session on a remote host they stop and say so.

## If something's wrong

- **`command not found: companion`**: run the `brew upgrade` command above. Or call the app's binary directly:
  `/Applications/Companion.app/Contents/MacOS/companion-desktop tui`
- ***Companion's terminal access is switched off***: tick **Let terminal agents use Companion** in **Settings → AI**.
- ***Companion isn't running***: open the Companion app. If it is open, quit and reopen it.
- ***terminal agents are read-only***: tick **Write tools** under **Terminal agents** in **Settings → AI**.
- **`companion tui` waits, then gives up**: update to 0.31.1 or later. Earlier versions could lose track of the running app after it was opened a second time. Quitting and reopening Companion fixes it until you update.
