---
title: How calendars work
group: Calendars
groupIcon: calendar
groupOrder: 4
order: 1
excerpt: Connect an account you can edit, or subscribe to a feed you only need to see.
featured: true
badge: Calendars
readTime: 4 min read
updated: Sep 2026
related: [calendar-icloud, calendar-google, calendar-subscriptions]
---

Companion doesn't want to replace your calendar. It wants to show it beside your work — and let you fix a meeting without leaving the page. Everything starts in **Settings → Calendar**, which has two sections: **Accounts** and **Subscriptions**.

## Which one do I want?

**An account** is two-way. Connect iCloud, Google, Fastmail, or any CalDAV server (Nextcloud, Radicale, Synology…) and you can create, edit and delete events in Companion; the change is written back to your provider. Start with [iCloud](/docs/calendar-icloud), [Fastmail](/docs/calendar-fastmail) or [Google](/docs/calendar-google).

**A subscription** is read-only: an ICS link or an uploaded `.ics` file. Use it for calendars you only need to see — public holidays, a team schedule, a fixture list. See [ICS subscriptions](/docs/calendar-subscriptions).

One gap worth knowing up front: Microsoft and Outlook calendars don't support CalDAV, so they can't be added as an account. A read-only subscription is the option there.

## Accounts are added from the desktop app

**Add account** appears in the desktop app, not the web app. Companion connects to your calendar provider directly from your device. A browser can't reach those servers, and routing your password through our server would defeat end-to-end encryption — so we don't.

The web app isn't left out. Accounts you added elsewhere are listed there, and their events are editable. The change is delivered by your desktop app the next time it's running, so an edit made on the web — or on your phone, which uses the web app until the iOS and Android apps ship — can sit pending until then.

Your calendar password (or Google sign-in) and your events sync between your devices end-to-end encrypted. The Companion sync server never sees them, and never contacts your calendar provider.

## The calendar screen

![The calendar week view, with events, tasks and a daily note on their days](/docs/calendar.png)

The week view merges three streams, each with its own colour in the legend: **events**, **tasks** on their due date, and **notes** dated to the day (your daily notes). Hover over anything for a detail card; the same card appears on agenda rows on [Today](/docs/today-home-base). Click a task or a note to open it.

The toolbar has previous and next week, **Today**, and a refresh button. Refresh is how changes made elsewhere arrive: Companion fetches your calendars when you press it, not on a timer. Your own edits don't wait for it — they're sent as soon as you make them. Once you have at least one calendar you can write to, a **+** button (**New event**) joins them.

## Editing events

Click an event in an account's calendar to open the editor: a title, **Date**, **Starts** and **Ends** — or **First day** and **Last day** when **All day** is ticked — then **Repeat**, a location, and notes. **Delete** is in the editor too.

You can also drag. Move a one-off event to another day or time, or drag its bottom edge to change when it ends, in 15-minute steps. Tasks can be dragged to reschedule as well. Repeating events can't be dragged.

A change that hasn't reached your provider yet shows the event slightly faded. If the event was changed somewhere else first — say, in your phone's calendar app — that version is kept and Companion tells you so. It never overwrites a newer change blindly.

Things Companion doesn't model — attendees, alerts, time zones set by another app — are preserved when you edit an event here.

> **Tip:** Calendars you only have read access to, like a shared calendar or a holidays list, are marked **read-only** in settings and can't be edited.

## Repeating events

**Repeat** offers **Never**, **Daily**, **Weekly**, **Monthly** and **Yearly**, with an "Every N…" interval and an optional end date.

Two honest caveats. Changes to a repeating event apply to **every occurrence** — there's no "this occurrence only" edit yet. Deleting is more flexible: Companion asks **This event only** or **All events**.

And a pattern Companion can't express — "third Monday", several weekdays, a fixed number of times — shows as **Custom**. It's kept exactly as it is unless you pick another option, which replaces it. You can change a custom event's time of day, but not move it to a different day.

## Refreshing and removing an account

The refresh icon on an account looks for calendars added on the provider since you set it up.

Removing an account removes its calendars and events from Companion on all your devices. **Nothing is deleted from the account itself.**

## No reminders for events

Reminders are for tasks only; events don't nudge you. If something needs a nudge, [give a task a reminder](/docs/creating-and-linking-tasks).

## Next steps

Connect [iCloud](/docs/calendar-icloud), [Fastmail](/docs/calendar-fastmail) or [Google](/docs/calendar-google), or add a read-only feed with [ICS subscriptions](/docs/calendar-subscriptions).
