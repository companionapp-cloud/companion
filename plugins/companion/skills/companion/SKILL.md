---
name: companion
description: Reads and updates the user's Companion workspace (notes, tasks, projects, habits, calendar events and canvases) through the companion MCP tools. Use when the user mentions Companion, or asks about their own notes, to-dos, tasks, projects, schedule, meetings or agenda, or asks to capture, file or change one of them.
---

# Companion

Companion is the user's notes, tasks, projects, calendar and canvases app. Its desktop app serves the `companion` MCP server to this session through `companion mcp`. The tools work on the user's real workspace, which syncs to their other devices, so treat writes as edits to their data.

## Read before you answer

- Call `get_date` before working out "today", "tomorrow", "this week" or any other relative date, and before setting a due date. It returns the user's local date, time and UTC offset.
- Find content with `search_notes` (notes, tasks and projects by text), `list_tasks`, `list_projects`, `list_project_items`, `list_areas` and `list_lists`.
- Load a note with `get_note` before you quote or summarize it. Search results are excerpts.
- Read the schedule with `list_events` (after `get_date`), and one event with `get_event`.
- See how things connect with `get_backlinks` and `get_neighborhood`. Read a board with `list_canvases` and `get_canvas`.
- Query structured objects with `list_object_types`, then `query_objects`.

Prefer these tools over guessing what the user has written. If a search comes back empty, try other words before you say something doesn't exist.

## Handwriting

Ink drawn on a note or notebook page isn't in its `contentMd`. When `get_note` or `get_page` reports `inkGroups`, the user wrote or drew there by hand.

- `read_ink` returns the ink as images: one per group on a note, with the text each was written over or beside, or one image of the whole sheet for a notebook page. Read the handwriting yourself.
- `transcribe_ink` reads it with on-device text recognition (Apple Vision, on a Mac). Use it when you can't see the images, or to check your own reading.
- To convert handwriting to typed text, call `convert_ink_to_text` with items of `groupIds` and `text`. Each item's text goes where its ink was, and that ink is erased. Convert only writing: leave drawings, arrows and circles as ink. When it's unclear which marks are writing, ask first.

## Write carefully

- `create_note`, `create_task`, `create_event`, `create_canvas`, `convert_ink_to_text` and the `update_*` tools change the workspace. Write tools are hidden unless the user allowed them in Companion › Settings › AI › Terminal agents.
- Before creating or changing more than a few items, show the user what you will do and ask.
- Link to other items with the wikilinks the tools return, such as `[[note:ID]]` and `[[task:ID]]`, so the links work inside Companion.
- After a write, say what changed and give the item's title.

## Replying in a terminal

Companion's chat previews don't exist here. Quote or summarize what matters, and refer to items by title. Include an id only when the user may need it in a later command.

## When the tools are missing or fail

- **No `companion` tools in this session:** the plugin or MCP server isn't configured, or the `companion` command isn't on `PATH`. Running `companion mcp` by hand should wait for input rather than print "command not found". The Homebrew cask installs the command. Otherwise use the path shown in Companion › Settings › AI › Terminal agents.
- **"Terminal agents are switched off":** ask the user to turn them on in Companion › Settings › AI, then restart this session.
- **"Companion isn't running":** ask the user to open the Companion desktop app.
- **"this agent is read-only":** the user hasn't allowed write tools. Tell them where the setting is, and don't try to work around it.
