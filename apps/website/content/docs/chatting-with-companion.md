---
title: Chatting with Companion
group: Made for AI
groupIcon: chat
groupOrder: 6
order: 1
excerpt: Install an agent — an AI tool on your computer or a cloud API — and let it work inside your notes.
featured: true
badge: Made for AI
readTime: 3 min read
updated: Sep 2026
related: [chat-into-tasks, getting-the-apps]
---

Companion has a chat built in, but no model of its own. You bring an *agent*: an AI tool already on your computer, like Claude Code, Codex, or Ollama, or a cloud API with your own Anthropic or OpenAI key. Nothing is inferred on our servers, and there's no AI subscription to buy.

## Add an agent

Open **Chat** and, until you have an agent, it'll point you at **Settings → AI**. Choose **Add agent**, then pick a tab:

- **On this computer** — in the [desktop app](/docs/getting-the-apps), the AI tools Companion found on your machine: Claude Code, Codex, a running Ollama server, and LM Studio. Choose **Install** and the tool becomes an agent hosted by that computer. There's no URL to type.
- **Cloud** — Anthropic or OpenAI, with an API key.
- **Advanced** — any other server that speaks the OpenAI Chat Completions API, by URL: Ollama on another machine, vLLM, OpenRouter.

In a browser or on a phone, that first tab is **On your computer** instead, and explains the desktop app — those tools can't run there.

![Settings → AI → Add agent, on the Cloud tab](/docs/ai-settings.png)

The *model* isn't chosen here. Each chat has its own picker, filled from whatever that agent currently offers, so you can run something cheap for a quick question and something stronger for real thinking. The first agent you add is the default; **Make default** on another changes that.

## Agents on your computer, from anywhere

An agent installed on your desktop runs there, but it isn't stuck there. Sign in to the same sync account on both devices and you can chat with it from the web app or your phone: your message travels through your sync server to the desktop, the desktop runs the turn, and the answer streams back. On an encrypted account those messages are end-to-end encrypted too, so the server passes them along without reading them.

It only works while that computer is on with Companion running. If it isn't, the chat tells you the agent's computer is offline rather than holding the message for later.

## Where API keys live

On an [end-to-end encrypted account](/docs/using-our-cloud), a cloud agent's API key syncs to your other devices, encrypted: enter it once and it works everywhere, and the server stores it without being able to read it. Otherwise the key stays on the device you entered it on, and never syncs.

## What it can see and do

The chat can read your workspace: it searches notes, lists tasks and projects, follows links and backlinks, reads a note in full, and queries [object types](/docs/object-types) by their fields. It reads your calendar too — events, plus the tasks due and daily notes on each day — and your canvases, card by card, with the groups and arrows between them. Claude Code and Codex get the same tools from the desktop app.

When it points you to something, it shows it right in the chat instead of pasting it: a note, a task you can tick off there, an event, a miniature of a canvas, or a graph of everything linked to a note or task. Click one to open it.

Two switches on each agent decide what else it may do:

- **Write tools** — create and edit notes, tasks and calendar events. On by default; off, the agent can only read and search. Events can go in any calendar of an account you've connected — Google, iCloud or another CalDAV server — but not in subscriptions, which are read-only. A change shows on your calendar at once and reaches your provider moments later.
- **System access** — Claude Code and Codex only: edit files in the agent's own workspace folder and run commands on your computer. Off by default, and worth leaving off unless you need it — when it's on, that includes turns you start from your phone.

On an encrypted account, the agent reads your workspace on the device that runs it, against local, decrypted data; the sync server only ever holds ciphertext. What you send to a model, though, goes to whoever runs that model, under their terms: Anthropic or OpenAI for the cloud APIs, and for Claude Code and Codex as well, since they call their makers' models with your account. Ollama and LM Studio are the options that keep everything on your own hardware.

## Browsing

Agents can also fetch a web page or run a search when a question needs the outside world. That works on the desktop and on your phone, but not for a cloud agent used from the web app — a browser tab is blocked from fetching arbitrary sites. An agent your desktop hosts can still browse when you chat with it from the web, because the desktop is what runs it.

## Next steps

Put it to work in [turning chat into tasks](/docs/chat-into-tasks).
