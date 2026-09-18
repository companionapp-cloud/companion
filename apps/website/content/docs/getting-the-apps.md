---
title: Getting the apps
group: Get started
groupIcon: today
groupOrder: 1
order: 1
excerpt: Install Companion on your Mac with Homebrew, or use it on the web with nothing to install.
featured: true
badge: Get started
readTime: 2 min read
updated: Sep 2026
related: [your-first-note, using-our-cloud]
---

Companion runs as a desktop app on your Mac and as a web app in any browser. Both work offline, and neither asks for an account until you want your work on more than one device.

## Install the desktop app

:::: tabs
::: tab macOS
Companion for Mac installs with [Homebrew](https://brew.sh). It's one universal app for Apple silicon and Intel Macs, and it needs macOS 11 Big Sur or later.

```bash
brew install --cask companionapp-cloud/tap/companion
```

That adds the Companion tap and puts **Companion** in your Applications folder. Open it from Launchpad or Spotlight.

The app doesn't update itself yet, so upgrade it through Homebrew:

```bash
brew upgrade --cask companion
```

Companion isn't notarized by Apple yet, so the cask clears the app's quarantine flag after installing it — without that, macOS would refuse to open it.
:::
::: tab Windows
**Coming soon.** There's no Windows build to download yet. Until there is, [use Companion on the web](#use-companion-on-the-web) — it runs in any modern browser.
:::
::: tab Linux
**Coming soon.** There's no Linux build to download yet. Until there is, [use Companion on the web](#use-companion-on-the-web) — it runs in any modern browser.
:::
::::

## Use Companion on the web

Nothing to install: open [web.companionapp.cloud](https://web.companionapp.cloud) and start writing. Everything lives in your browser — notes, tasks, projects, the graph — and keeps working offline. No sign-up, no server, nothing leaves the machine. It's also the way to use Companion on a phone until the iOS and Android apps ship.

The catch is the obvious one — a workspace held in one browser stays in that browser. Sign in and it follows you.

A few things need the desktop app, because a browser tab can't do them: the global quick-capture shortcut, reminder notifications that fire with no tab open, and hosting AI agents that run on your computer, like Claude Code, Codex, and Ollama. Once the desktop app hosts an agent, you can chat with it from the web too — through your sync server, while that computer is on.

## Sync when you want it

To keep two devices in step, connect a server in **Settings → Sync**: either [Companion Cloud](/docs/using-our-cloud) or [one you host yourself](/docs/self-hosting). New accounts are end-to-end encrypted, so the server stores your notes without being able to read them.

A couple of features need a server, because they're computed there: repeating tasks, and calendar feed refreshes.

## Next steps

Write [your first note](/docs/your-first-note), then track [your first task](/docs/your-first-task).
