---
title: Fastmail
group: Calendars
groupIcon: calendar
groupOrder: 3
order: 3
excerpt: Connect your Fastmail calendars with an app password — or any other CalDAV server the same way.
badge: Calendars
readTime: 3 min read
updated: Sep 2026
related: [calendars, calendar-subscriptions, calendar-icloud]
---

Add your Fastmail account and its calendars become two-way calendars in Companion: your events appear, and you can create and change them. Fastmail doesn't accept your main password for calendar access, so you'll make an **app password** first.

## Before you start

- Use the **desktop app**. Accounts can't be added from the web app: Companion talks to Fastmail directly from your device, which a browser can't do, and sending your password through Companion's server would defeat end-to-end encryption. Once the account is added, you can view and edit its events everywhere, web included. Edits made on the web are delivered by your desktop app the next time it's running.
- Your Fastmail plan needs to include access from other apps. Fastmail's Basic plan doesn't, and can't create app passwords.

## Create an app password

1. Log in to Fastmail on the web and open **Settings → Privacy & Security**.
2. In the **Connected apps & API tokens** section, click **Manage app passwords and access**.
3. Click **New app password**. Fastmail may ask for your password to confirm it's you.
4. Give it a name you'll recognise later: choose **Custom** and enter "Companion".
5. Choose the access it gets. The default, **Mail, Contacts & Calendars**, includes calendars (CalDAV), which is what Companion needs.
6. Click **Generate password**, and copy the password shown on the next page.

Fastmail shows the password once; it can't be displayed again later. If you lose it before pasting it into Companion, make another.

> **Tip:** Back on that same screen you can **Disable** or **Remove** the app password at any time. That disconnects Companion without touching your main Fastmail password.

## Add the account in Companion

1. Open **Settings → Calendar**, and under **Accounts** choose **Add account**.
2. In the **Add a calendar account** dialog, choose **Fastmail**. The server address (caldav.fastmail.com) is filled in for you.
3. In **Username**, enter your full Fastmail address.
4. In **Password**, paste the app password.
5. Choose **Add account**.

Companion checks the login with Fastmail before it saves anything, so if the dialog closes, the account works. Every calendar on the account appears under it, in the colour it has in Fastmail. Calendars you can only read are marked **read-only**.

Creating, editing, repeating events and what happens when two devices change the same event are covered in [Calendars](/docs/calendars).

## What stays private

Your app password and your events sync between your devices end-to-end encrypted. The Companion sync server never sees them, and it never contacts Fastmail — only your own devices do.

## Manage the account

- The **refresh** icon on the account's row looks for calendars you've added in Fastmail since.
- The **trash** icon removes the account. Its calendars and events disappear from Companion on all your devices. Nothing is deleted from the account itself.

## Other CalDAV servers

Nextcloud, Radicale, Synology, Zimbra and any other standard CalDAV server work the same way. In the dialog choose **Other**, which adds a **Server** field for your server's address, then enter your **Username** and **Password** as above. https is required, except for a server on your own network. If your provider offers app passwords, use one.

## If it doesn't work

**"The server rejected the username or password."** Usually your main Fastmail password was used; Fastmail only accepts an app password here. Also check that **Username** is your full address, and that the app password's access includes calendars — one made for **Files (WebDAV)** only won't work.

**"No calendars were found at that address."** On the **Other** tab, this means the **Server** address doesn't lead to your calendars. Check your provider's documentation for its CalDAV address.

**It worked, then stopped.** If syncing fails, the reason is shown in red under the account. A rejected login usually means the app password was disabled or removed at Fastmail. Make a new one, then remove the account in Companion and add it again.

**There's no Add account button.** You're in the web app. Add the account from the [desktop app](/docs/getting-the-apps) instead.

## Next steps

Only need to see a calendar, not edit it? A [calendar subscription](/docs/calendar-subscriptions) is simpler. Using other providers too? See [iCloud Calendar](/docs/calendar-icloud) and [Google Calendar](/docs/calendar-google), or head back to the [Calendars overview](/docs/calendars).
