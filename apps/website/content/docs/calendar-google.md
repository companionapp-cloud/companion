---
title: Google Calendar
group: Calendars
groupIcon: calendar
groupOrder: 4
order: 4
excerpt: Sign in with Google to see and edit your Google calendars — and what to do if your version doesn't offer it yet.
badge: Calendars
readTime: 3 min read
updated: Sep 2026
related: [calendars, calendar-subscriptions, calendar-icloud]
---

Google's calendar server only accepts Google's own sign-in, so connecting it works differently from [iCloud](/docs/calendar-icloud) or [Fastmail](/docs/calendar-fastmail): there's no password field. You sign in on Google's page in your browser, and Companion never sees your Google password.

## Check that your version offers it

The **Google** tab only appears in versions of Companion that include Google sign-in. If you open the **Add a calendar account** dialog and see only **iCloud**, **Fastmail** and **Other**, your version doesn't offer it yet.

Until it does, you can still see your Google calendar with a read-only [calendar subscription](/docs/calendar-subscriptions): use your calendar's "Secret address in iCal format" from Google Calendar's settings. You won't be able to edit events from Companion that way.

## Connect your Google account

Do this from the **desktop app**. Accounts can't be added from the web app, because Companion talks to Google directly from your device. Once connected, you can view and edit the account's events everywhere, web included; edits made on the web are delivered by your desktop app the next time it's running.

1. Open **Settings → Calendar**, and under **Accounts** choose **Add account**.
2. In the **Add a calendar account** dialog, choose **Google**, then **Sign in with Google**. The button changes to **Waiting for Google…** and your browser opens Google's sign-in page.
3. Pick your Google account and review what Companion is asking for. **Leave the calendar permission ticked** — without it Companion can't read your calendars.
4. Approve, then return to Companion. The dialog closes and the account appears.

While Companion's Google integration is awaiting Google's verification, Google may show a notice that the app is unverified during sign-in. Whether you see it depends on where that review stands.

Every calendar on the account appears under it, in the colour it has in Google. Calendars you can only read are marked **read-only**. Creating, editing, repeating events and conflicts are covered in [Calendars](/docs/calendars).

## What stays private

Your Google sign-in and your events sync between your devices end-to-end encrypted. The Companion sync server never sees them, and it never contacts Google — only your own devices do.

## One device does the talking

A Google account connected on one kind of device — say, the Mac app — is synced to Google by that device. Your other devices still show its events and let you edit them; their changes are delivered through the device that connected it.

If another device says it can't sync this Google account directly because it was connected from another kind of device, that's what this means. It isn't an error.

## Remove Companion's access

- The **trash** icon on the account's row removes the account from Companion. Its calendars and events disappear from Companion on all your devices. Nothing is deleted from the account itself.
- Removing the account **doesn't revoke the permission you gave at Google**. To do that, go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions), find Companion, and remove its access. You can do this at any time, with or without removing the account in Companion first.

The **refresh** icon on the account's row looks for calendars you've added in Google since.

## If it doesn't work

**"Companion wasn't given access to your calendars."** The calendar permission was unticked on Google's consent page. Sign in again and leave it ticked.

**The account shows a message and a Reconnect button.** Companion's access has expired or was removed at Google. Choose **Reconnect** and sign in again — as the same Google user. Signing in as a different one is refused, and Companion tells you which account it expected.

**Nothing happens after approving in the browser.** Switch back to Companion; the dialog waits until Google answers. If you closed the browser tab, choose **Cancel** and start again.

**Something else.** If syncing fails, the reason is shown in red under the account.

## Next steps

Read [Calendars](/docs/calendars) for working with events, or set up a [calendar subscription](/docs/calendar-subscriptions) for calendars you only need to see.
