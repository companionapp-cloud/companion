---
title: App won't sync
group: Troubleshooting
groupIcon: settings
groupOrder: 5
order: 2
excerpt: What to do when sync stalls, locks, or conflicts.
badge: Troubleshooting
readTime: 3 min read
updated: Jul 2026
related: [run-into-a-problem, using-our-cloud]
---

Sync trouble is usually one of four things. **Settings → Sync** tells you which — check the **Status** line before anything else.

## "locked — unlock to sync"

Your encryption key isn't loaded on this device. It happens after clearing browser data, or on a fresh device. Enter your password under **Unlock encryption** and sync resumes where it left off.

## "Session expired"

Your login token aged out. Enter your password and sign in again — nothing is lost, and nothing needs to be re-downloaded.

## Nothing is moving

Work down the list:

1. Confirm the device is **online** — sync pauses without a connection and picks up on its own.
2. Check the **Server URL** is the one you expect, and that you're **signed in** on *every* device you're comparing.
3. Hit **Sync now** to force a pass rather than waiting for the next one.

If you're [self-hosting](/docs/self-hosting), the next question is whether the server itself is reachable at that URL.

## A note asks you to choose a version

If the same note was edited in two places while one was offline, Companion won't silently pick a winner — it shows you the conflict and asks. Choose the version to keep; the other is discarded.

> **Tip:** A **v0 / unsynced** badge on a note means it exists only on this device. That's expected before you connect a server — it isn't an error.

## Next steps

Still stuck? [Contact us](/contact) with your platform and what the Status line says.
