---
title: Claude Code & Codex in your terminal
group: Made for AI
groupIcon: chat
groupOrder: 6
order: 3
excerpt: Give the Claude Code or Codex sessions you start in a terminal the same Companion tools the chat has.
badge: Made for AI
readTime: 3 min read
updated: Nov 2026
related: [chatting-with-companion, companion-in-your-terminal]
---

[Chatting with Companion](/docs/chatting-with-companion) runs Claude Code or Codex inside the app. You can also go the other way. A Claude Code or Codex session you start in your own terminal, in any project, can search your notes, read your schedule, and add the task you just thought of.

The session gets the same tools as Companion's chat: searching notes, listing tasks and projects, reading the calendar and canvases, following links, and (if you allow it) creating and editing notes, tasks, events and canvases. A plugin installs them, along with a skill that tells the agent how to use them well.

## Turn it on

You need the desktop app on a Mac, installed with Homebrew (see [Getting the apps](/docs/getting-the-apps)). If you installed it before version 0.31, update it once, so the `companion` command is on your `PATH`:

```bash
brew update && brew upgrade --cask companionapp-cloud/tap/companion
```

Then open **Settings → AI** and, under **Terminal agents**:

- **Let terminal agents use Companion** switches it on.
- **Write tools** lets the agent create and edit notes, tasks and events. Off, it can only read and search.

The same switches cover Companion's own [terminal commands](/docs/companion-in-your-terminal).

## Install the plugin

The section also shows these commands.

:::: tabs
::: tab Claude Code
```bash
claude plugin marketplace add companionapp-cloud/companion
claude plugin install companion@companion
```
:::
::: tab Codex
```bash
codex plugin marketplace add companionapp-cloud/companion
codex plugin add companion@companion
```
:::
::::

Start a new session, or restart one that was already open, then ask about your work: *what's on my calendar tomorrow?*, *find my notes on the pricing page*, *add a task to review the launch post on Friday*.

Prefer just the tools, without the skill? Register the server yourself:

```bash
claude mcp add --scope user companion -- companion mcp
codex mcp add companion -- companion mcp
```

## How it works

`companion mcp` is a small MCP server that Claude Code or Codex starts for each session. It passes each request to the Companion app running on your Mac, and starts the app in the menu bar if it isn't running. It never opens your data itself, so what the agent changes is saved, synced and shown in open windows exactly as if you'd done it in the app.

The app only listens on your own Mac (`127.0.0.1`). It keeps the address and key the command uses in `~/Library/Application Support/Companion`, in a file only your user account can read. Turning terminal agents off closes the server.

What a model reads goes to whoever runs it. Claude Code and Codex call Anthropic's and OpenAI's models with your own account, so anything they read from Companion is sent there under those terms.

## If something's wrong

- **No Companion tools in the session**: check the plugin is installed and enabled (`/plugin` in Claude Code, `/mcp` in Codex), and that `companion mcp` runs in your terminal. Then restart the session.
- ***terminal agents are switched off***: tick **Let terminal agents use Companion** in **Settings → AI**, then restart the session.
- ***Companion isn't running***: open the Companion app. If it is open, quit and reopen it.
- ***this agent is read-only***: tick **Write tools** under **Terminal agents**.
- **A Codex run says the tool *requires approval***: `codex exec` can't ask you, so it refuses tools that need approval. Run Codex interactively, or approve Companion's tools in your Codex config.
