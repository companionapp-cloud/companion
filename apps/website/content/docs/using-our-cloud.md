---
title: Using our cloud
group: Companion Cloud & sync
groupIcon: refresh
groupOrder: 3
order: 1
excerpt: Create an account, sync every device, and keep your notes unreadable to us.
featured: true
badge: Companion Cloud
readTime: 3 min read
updated: Jul 2026
related: [self-hosting, app-wont-sync]
---

Companion Cloud keeps your devices in step. New accounts are end-to-end encrypted: your notes are encrypted on your device, and the server stores them without the ability to read them.

## Create your account

Accounts are created in the [Companion Cloud portal](https://portal.companionapp.cloud) — sign up, pick a plan, and it'll give you the server URL to point your apps at.

## Sign in

Then, in the app, open **Settings → Sync**, enter that **Server URL** along with the **Email** and **Password** you registered with, and choose **Log in**.

![Settings → Sync, before signing in](/docs/sync-settings.png)

Do the same on your other devices — same server, same account — and everything flows between them. Work offline and it reconciles the moment you reconnect.

## Your recovery code

The first time your account is encrypted, Companion shows you a **recovery code** exactly once. Save it somewhere safe.

Your password unlocks the key that decrypts your notes, and we don't have that key. If you forget your password, the recovery code is the only way back in — without it, the data is unrecoverable, by design.

## What's encrypted, and what isn't

The honest version, because "end-to-end encrypted" gets used loosely:

**Encrypted** — note titles and content, task titles and notes, project and area names, object type definitions, chat messages, file names, calendar feed names and events. The substance.

**Not encrypted** — the scheduling and bookkeeping metadata the server needs to do its job: due dates, reminder times, repeat rules, ordering, timestamps, and which item relates to which. The server can see *that* a task is due Thursday; it cannot see what the task says.

This is what makes repeating tasks and reminders work server-side without handing over your content.

## Next steps

Prefer to own the infrastructure? [Host your own](/docs/self-hosting) — the app works identically.
