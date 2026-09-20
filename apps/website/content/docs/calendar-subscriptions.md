---
title: ICS subscriptions
group: Calendars
groupIcon: calendar
groupOrder: 4
order: 5
excerpt: Show a read-only calendar from a link or an .ics file beside your work.
badge: Calendars
readTime: 3 min read
updated: Sep 2026
related: [calendars, calendar-google, today-home-base]
---

A subscription shows someone else's calendar — or one of your own — without giving Companion any way to change it. It's an ICS link or an uploaded `.ics` file, and it is always read-only: you can't add or edit events in a subscription, because there is no way to write back to an ICS feed.

## When to use one

- A calendar you only need to see: public holidays, a team schedule, a sports fixture list.
- A provider with no CalDAV. Microsoft and Outlook calendars can't be added as an [account](/docs/calendars), so this is the option.
- Google, on a version of Companion that doesn't offer [Google sign-in](/docs/calendar-google) yet.

If you want to create and edit events, you want an account instead — see [how calendars work](/docs/calendars).

## Add a subscription

In **Settings → Calendar**, under **Subscriptions**, choose **Add subscription**. Pick **Subscribe by URL** and paste the link, or **Upload .ics file** and choose a file. Then give it a **Name** and a **Color**, which tints its events in the calendar.

`webcal://` links work as well as `https://`.

An uploaded file is a snapshot — there's no link to fetch again, so it won't pick up later changes. Subscribe by URL if the calendar is still moving.

## Where to find an ICS link

**Google Calendar** — open Settings, pick the calendar under "Settings for my calendars", go to "Integrate calendar", and copy the "Secret address in iCal format".

**iCloud** — in Calendar on icloud.com, open the calendar's sharing options, turn on **Public Calendar**, and copy the link. Be aware of what that does: the calendar becomes readable by anyone who has the link.

**Anything else** — look for "subscribe", "export", or "iCal/ICS" in the calendar's sharing settings.

> **Tip:** An ICS link is itself a secret. Anyone who has it can read that calendar, so treat it like a password.

## How it's fetched

The feed is fetched by your device, not by Companion's server, and its events sync to your other devices encrypted.

One honest caveat: in the **web app**, a browser can't fetch a calendar from another site directly. So the web app fetches it through a pass-through on the sync server, which stores and logs nothing. The desktop app fetches it directly.

A feed is fetched when you press the refresh button in the calendar's toolbar — not on a timer. If a subscribed calendar looks out of date, that's the fix.

## What you'll see

Subscription events appear in the week view and in the agenda on [Today](/docs/today-home-base), in the colour you chose. Hover over one for its details. Clicking doesn't open an editor — there's nothing to edit.

Reminders are for tasks only; events don't nudge you.

To stop following a calendar, use the trash icon on its row in **Settings → Calendar**.

## Next steps

Want to edit events, not just see them? Read [how calendars work](/docs/calendars), or connect [Google](/docs/calendar-google) directly.
