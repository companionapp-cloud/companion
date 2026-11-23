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
