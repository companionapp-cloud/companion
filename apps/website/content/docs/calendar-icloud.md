---
title: iCloud Calendar
group: Calendars
groupIcon: calendar
groupOrder: 4
order: 2
excerpt: Connect your iCloud calendars with an app-specific password, and edit their events from Companion.
badge: Calendars
readTime: 3 min read
updated: Sep 2026
related: [calendars, calendar-subscriptions, calendar-google]
---

Add your iCloud account and its calendars show up in Companion as two-way calendars: you see your events, and you can create and change them. The one thing to know before you start is that Apple won't accept your normal password here. You need an **app-specific password**, which takes a minute to make.

## Before you start

- Use the **desktop app**. Accounts can't be added from the web app: Companion talks to iCloud directly from your device, which a browser can't do, and sending your password through Companion's server would defeat end-to-end encryption. Once the account is added, you can view and edit its events everywhere, web included. Edits made on the web are delivered by your desktop app the next time it's running.
- Your Apple Account needs **two-factor authentication** turned on. Apple only offers app-specific passwords to accounts that have it.

## Create an app-specific password

1. Sign in at [account.apple.com](https://account.apple.com).
2. In the **Sign-In and Security** section, select **App-Specific Passwords**.
3. Select **Generate an app-specific password** and follow the steps on screen. When you're asked for a label, use something you'll recognise later, like "Companion".
4. Copy the password Apple shows you. It looks like `abcd-efgh-ijkl-mnop`.

Apple shows the password once. If you lose it before pasting it into Companion, just generate another.

> **Tip:** An app-specific password is a key for one app. You can revoke it from the same page at any time, which disconnects Companion without touching your Apple Account password.

## Add the account in Companion

1. Open **Settings → Calendar**, and under **Accounts** choose **Add account**.
2. In the **Add a calendar account** dialog, choose **iCloud**. The server address (caldav.icloud.com) is filled in for you.
3. In **Username**, enter your Apple Account email.
4. In **Password**, paste the app-specific password — not your Apple Account password.
5. Choose **Add account**.

Companion checks the login with iCloud before it saves anything, so if the dialog closes, the account works. Every calendar on the account appears under it, in the colour it has in iCloud. Calendars you can only read are marked **read-only**.

Creating, editing, repeating events and what happens when two devices change the same event are covered in [Calendars](/docs/calendars).

## What stays private

Your app-specific password and your events sync between your devices end-to-end encrypted. The Companion sync server never sees them, and it never contacts Apple — only your own devices do.

## Manage the account

- The **refresh** icon on the account's row looks for calendars you've added in iCloud since.
- The **trash** icon removes the account. Its calendars and events disappear from Companion on all your devices. Nothing is deleted from the account itself.

If you change your Apple Account password, Apple revokes every app-specific password automatically. Create a new one, then remove the account in Companion and add it again with the new password.

## If it doesn't work

**"The server rejected the username or password."** Almost always, this means the regular Apple Account password was used. Companion's message reminds you that iCloud needs an app-specific password. Generate one and try again, and check that **Username** is your full Apple Account email.

**It worked, then stopped.** If syncing fails, the reason is shown in red under the account. A rejected login after weeks of working usually means the app-specific password was revoked, either by you or by a change of Apple Account password.

**There's no Add account button.** You're in the web app. Add the account from the [desktop app](/docs/getting-the-apps) instead.

## Next steps

Only need to see a calendar, not edit it? A [calendar subscription](/docs/calendar-subscriptions) is simpler. Using other providers too? See [Google Calendar](/docs/calendar-google) and [Fastmail](/docs/calendar-fastmail), or head back to the [Calendars overview](/docs/calendars).
