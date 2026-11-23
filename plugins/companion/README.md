# Companion plugin for Claude Code and Codex

Lets Claude Code and Codex sessions you start in a terminal read and update your Companion notes, tasks, projects, calendar and canvases. It bundles:

- the `companion` MCP server, which runs `companion mcp`
- the `companion` skill, which tells the agent how to use those tools

## Requirements

- The Companion desktop app, with **Settings › AI › Terminal agents** switched on. Turn on write tools there too if the agent should create and edit items.
- The `companion` command on your `PATH`. The Homebrew cask (`brew install --cask companionapp-cloud/tap/companion`) links it.

`companion mcp` relays to the running app and starts it in the menu bar when it isn't running. Nothing listens beyond `127.0.0.1`. The app writes its endpoint and token to `terminal-agents.json` in `~/Library/Application Support/Companion`, readable only by you.

## Install

Claude Code:

```bash
claude plugin marketplace add companionapp-cloud/companion
claude plugin install companion@companion
```

Codex:

```bash
codex plugin marketplace add companionapp-cloud/companion
codex plugin add companion@companion
```

### Without the plugin

Register only the MCP server. If `companion` isn't on your `PATH`, use `/Applications/Companion.app/Contents/MacOS/companion-desktop` instead.

```bash
claude mcp add --scope user companion -- companion mcp
codex mcp add companion -- companion mcp
```

The Codex command writes this to `~/.codex/config.toml`:

```toml
[mcp_servers.companion]
command = "companion"
args = ["mcp"]
```

## In the terminal without an agent

The same terminal access powers two commands of Companion's own. Both start the app in the menu bar when it isn't running.

- `companion tui [today|calendar|notes|tasks|canvases|graph]` opens a terminal UI. It has tabs for today's daily note (saved as you type), a day or week agenda, notes with a Markdown preview and an editor, tasks (`x` done, `d` due date, `n` new), canvases shown as an outline of cards and connections, and a link graph you can walk through.
- `companion new note TITLE [--body TEXT]` and `companion new task TITLE [--due WHEN] [--start WHEN]` create one item. `WHEN` is plain words, such as `tomorrow 5pm`.

Creating and editing needs write tools switched on. Terminal programs can read notes, tasks, projects, lists, the calendar, canvases and the graph, and can only create and edit notes and tasks. They can never delete anything.

### Rex

`companion rex install` adds Companion to Rex's palette. It writes the plugin to `~/.config/rex/plugins/companion/init.lua` and loads it from `~/.config/rex/init.lua`. Run it again to update. Then run `rex config reload`.

- **Companion: Open** opens the TUI in a new tab. **Companion: Today's Note**, **Calendar**, **Notes**, **Tasks**, **Canvases** and **Graph** open it in a split beside the current pane.
- **Companion: New Note…** asks for a title and the first lines. **Companion: New Task…** asks for a title and a due date, and asks again if the date doesn't parse.
