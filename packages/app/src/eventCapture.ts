import type { ParsedDate } from "@companion/core-bridge";
import { localDay } from "./paletteModel";

// Quick capture for calendar events (PLAN §6.4): how its two questions — "When is it?" and "For
// how long?" — become an event's span. The phrases are read by core's dates.parse, as a task's
// due date is; this module decides what they mean for an event: whether a time of day was said at
// all (none makes it an all-day event, as calendars' own quick-add reads "lunch friday"), how long
// it runs, and how the result is echoed back under the fields.

/** A new event's span, in local terms. `end` is exclusive: for an all-day event, the midnight
 *  after its last day. */
export interface EventSpan {
  start: Date;
  end: Date;
  allDay: boolean;
}

/** What the two answers read as, so far. `span` is null until both read; an error names the
 *  field it belongs to. */
export interface EventReading {
  span: EventSpan | null;
  /** What "when" read as, echoed under it: the whole span once the length reads too
   *  ("Tue, Sep 23 · 3:00 PM – 4:00 PM"), else just the start. */
  whenHint: string | null;
  whenError: string | null;
  /** What "for how long?" read as — "1 hr 30 min", "until 5:00 PM" — echoed under that field. */
  lengthHint: string | null;
  lengthError: string | null;
}

type DateParser = (text: string, ref?: string) => Promise<ParsedDate | null>;

/** How long an event runs when the question is left blank: an hour, or the one day. */
const DEFAULT_MINUTES = 60;
const DAY_MINUTES = 24 * 60;

export const WHEN_UNREADABLE = "Couldn’t read a time — try “tomorrow 3pm” or “friday”.";
export const WHEN_MISSING = "When is it? Try “tomorrow 3pm” or “friday”.";
const LENGTH_UNREADABLE = "Couldn’t read that — try “30 min”, “2 hours” or “until 5pm”.";
const LENGTH_BACKWARDS = "It has to end after it starts.";

/** Read both answers. "When" is required for a span; "for how long?" is optional — a length
 *  ("90 min", "2 days") or an end ("until 5pm", read from the start's day). */
export async function readEvent(when: string, length: string, parse: DateParser): Promise<EventReading> {
  const reading: EventReading = { span: null, whenHint: null, whenError: null, lengthHint: null, lengthError: null };
  let start: { at: Date; allDay: boolean } | null = null;
  if (when.trim()) {
    const parsed = await parse(when.trim());
    if (parsed) start = { at: new Date(parsed.at), allDay: !saysTimeOfDay(parsed.matched) };
    else reading.whenError = WHEN_UNREADABLE;
  }

  let minutes: number | null = null;
  let until: Date | null = null;
  if (length.trim()) {
    minutes = parseDuration(length);
    if (minutes == null) {
      // An end reads from the start: "until 5pm" is that day's 5pm, not today's.
      const parsed = await parse(endPhrase(length), start ? localRfc3339(start.at) : undefined);
      if (parsed) until = new Date(parsed.at);
      else reading.lengthError = LENGTH_UNREADABLE;
    }
  }
  if (minutes != null) reading.lengthHint = formatDuration(start?.allDay ? wholeDays(minutes) * DAY_MINUTES : minutes);
  if (!start) return reading;
  reading.whenHint = start.allDay ? `${dateLabel(start.at)} · all day` : `${dateLabel(start.at)} · ${timeLabel(start.at)}`;
  if (reading.lengthError) return reading;

  const span = eventSpan(start.at, start.allDay, minutes, until);
  if (!span) {
    reading.lengthError = LENGTH_BACKWARDS;
    return reading;
  }
  if (until) reading.lengthHint = `until ${span.allDay ? dateLabel(lastDay(span)) : sameDay(span.start, span.end) ? timeLabel(span.end) : `${dateLabel(span.end)} · ${timeLabel(span.end)}`}`;
  reading.span = span;
  reading.whenHint = formatEventSpan(span);
  return reading;
}

/** The span from a start and a length or an end; null when the end isn't after the start. An
 *  all-day event runs whole days: a length rounds up to them, and an end is its last day. */
export function eventSpan(start: Date, allDay: boolean, minutes: number | null, until: Date | null): EventSpan | null {
  if (allDay) {
    const first = startOfDay(start);
    const days = until ? Math.round((startOfDay(until).getTime() - first.getTime()) / 86_400_000) + 1 : wholeDays(minutes ?? DAY_MINUTES);
    if (days < 1) return null;
    return { start: first, end: new Date(first.getFullYear(), first.getMonth(), first.getDate() + days), allDay: true };
  }
  const end = until ?? new Date(start.getTime() + (minutes ?? DEFAULT_MINUTES) * 60_000);
  return end.getTime() > start.getTime() ? { start, end, allDay: false } : null;
}

/** The span as `calendar.events.create` takes it. An all-day event travels as date markers
 *  (midnight UTC of its first day, and of the day after its last), the shape iCalendar uses. */
export function eventTimes(span: EventSpan): { startsAt: string; endsAt: string; allDay: boolean } {
  if (span.allDay) return { startsAt: marker(span.start), endsAt: marker(span.end), allDay: true };
  return { startsAt: span.start.toISOString(), endsAt: span.end.toISOString(), allDay: false };
}

/** "Tue, Sep 23 · 3:00 PM – 4:00 PM", or "Fri, Sep 26 · all day" — the confirmation under "When
 *  is it?". A span crossing midnight dates both ends. */
export function formatEventSpan(span: EventSpan): string {
  if (span.allDay) {
    const last = lastDay(span);
    return sameDay(span.start, last) ? `${dateLabel(span.start)} · all day` : `${dateLabel(span.start)} – ${dateLabel(last)} · all day`;
  }
  if (sameDay(span.start, span.end)) return `${dateLabel(span.start)} · ${timeLabel(span.start)} – ${timeLabel(span.end)}`;
  return `${dateLabel(span.start)} · ${timeLabel(span.start)} – ${dateLabel(span.end)} · ${timeLabel(span.end)}`;
}

// What in the phrase dates.parse understood says a time of day rather than just a day: a clock
// time ("3pm", "15:30"), a part of the day ("noon", "tonight"), "now", or a span shorter than a day
// ("in 2 hours"). Mirrors the time rules of the parser core uses (olebedev/when).
const TIME_OF_DAY = /\d\s*[ap]\.?(?:m\.?)?(?![a-z])|\d\s*[:：]\s*[0-5]\d|\b(?:now|tonight|night|morning|afternoon|evening|noon|midnight)\b|\b(?:sec(?:ond)?s?|min(?:ute)?s?|hours?)\b/i;

/** Whether a parsed phrase named a time of day. "friday" didn't; "friday 3pm" did. */
export function saysTimeOfDay(matched: string): boolean {
  return TIME_OF_DAY.test(matched);
}

const UNIT_MINUTES: Record<string, number> = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  d: DAY_MINUTES, day: DAY_MINUTES, days: DAY_MINUTES,
  w: 7 * DAY_MINUTES, wk: 7 * DAY_MINUTES, wks: 7 * DAY_MINUTES, week: 7 * DAY_MINUTES, weeks: 7 * DAY_MINUTES,
};
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Minutes in a length: "30 min", "1.5 hours", "1h30", "an hour and a half", "2 days", "1:30".
 *  Null when it isn't one — a bare "2" could be minutes or hours, so it isn't either. */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/^for\s+/, "");
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (clock) return positive(Number(clock[1]) * 60 + Number(clock[2]));
  const words = s
    .replace(/\bhalf\s+an?\b/g, "0.5")
    .replace(/\band\s+a\s+half\b/g, " +half")
    .replace(/\ban?\b/g, "1")
    .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => String(NUMBER_WORDS[w]))
    .replace(/\band\b|,/g, " ")
    // "1h30m" → "1 h 30 m"
    .replace(/(\d)(?=[a-z+])/g, "$1 ")
    .replace(/([a-z])(?=\d)/g, "$1 ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  let total = 0;
  let unit = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "+half") {
      if (!unit) return null;
      total += unit / 2;
      continue;
    }
    const n = Number(w);
    if (!Number.isFinite(n)) return null;
    const next = UNIT_MINUTES[words[i + 1]];
    if (next) {
      total += n * next;
      unit = next;
      i++;
    } else if (unit === 60 && i === words.length - 1) {
      // The minutes of "1h30".
      total += n;
    } else {
      return null;
    }
  }
  return positive(Math.round(total));
}

/** "1 hr 30 min", "2 days", "1 day 2 hr". */
export function formatDuration(minutes: number): string {
  const days = Math.floor(minutes / DAY_MINUTES);
  const hours = Math.floor((minutes % DAY_MINUTES) / 60);
  const mins = minutes % 60;
  return [days ? `${days} ${days === 1 ? "day" : "days"}` : "", hours ? `${hours} hr` : "", mins ? `${mins} min` : ""].filter(Boolean).join(" ");
}

/** An end phrase without its lead-in: "until 5pm" → "5pm". */
function endPhrase(text: string): string {
  return text.trim().replace(/^(?:until|till|til|to|through|thru|ending|ends?)(?:\s+at|\s+on)?\s+/i, "");
}

/** A local instant as RFC3339 with its UTC offset (not 'Z'): the `ref` dates.parse reads a
 *  phrase from, so "5pm" is that day's 5pm in the user's timezone. */
export function localRfc3339(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

const positive = (n: number) => (n > 0 ? n : null);
const wholeDays = (minutes: number) => Math.max(1, Math.ceil(minutes / DAY_MINUTES));
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const marker = (d: Date) => `${localDay(d)}T00:00:00.000Z`;
const lastDay = (span: EventSpan) => new Date(span.end.getFullYear(), span.end.getMonth(), span.end.getDate() - 1);
const sameDay = (a: Date, b: Date) => localDay(a) === localDay(b);
const dateLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
