---
title: Chatting with Companion
group: Made for AI
groupIcon: chat
groupOrder: 4
order: 1
excerpt: Connect a model — yours or a hosted one — and let it work inside your notes.
featured: true
badge: Made for AI
readTime: 3 min read
updated: Jul 2026
related: [chat-into-tasks, object-types]
---

Companion has a chat built in, but no model of its own. You bring one: a local Ollama server, or an OpenAI or Anthropic key. Nothing is inferred on our servers, and there's no AI subscription to buy.

## Connect a model

Open **Chat** and, until a provider exists, it'll point you at **Settings → AI**.

![The AI settings, with Ollama, OpenAI, and Anthropic presets](/docs/ai-settings.png)

Pick a preset and give it the one thing it needs:

- **Ollama** — a **Server URL** (`http://localhost:11434/v1` by default). Runs entirely on your own machine.
- **OpenAI** or **Anthropic** — an **API key**.

Keys stay on the device — the system keychain natively, browser storage on the web — and are never written to the database or handed to a sync server.

The *model* isn't chosen here. Each chat has its own picker, filled from whatever that provider currently offers, so you can run something cheap for a quick question and something stronger for real thinking.

## What it can see

The chat can read your workspace: it searches notes, lists tasks and projects, follows links and backlinks, reads a note in full, and queries [object types](/docs/object-types) by their fields. It can also write — creating and updating notes and tasks — which is what makes it useful rather than merely conversational.

On an encrypted account, all of that happens on your device against local, decrypted data; the sync server only ever holds ciphertext. What you send to a *hosted* model, though, goes to that provider under their terms. Ollama is the option that keeps everything local.

## Browsing

On desktop and mobile the AI can also fetch a web page and run a search when a question needs the outside world. The web app can't — a browser tab is blocked from fetching arbitrary sites — so web chat stays inside your workspace.

## Next steps

Put it to work in [turning chat into tasks](/docs/chat-into-tasks).
