// Repeat-rule presets and human-readable labels for the task editor (PLAN §6.4). The core
// is the source of truth for RRULE parsing and occurrence generation; these are just the
// handful of common cadences the UI offers as one-tap choices, plus a best-effort label so a
// stored rule reads as words. A power user can still hand-author any RRULE the core accepts.

/** One repeat option offered in the editor. An empty `rule` means "does not repeat". */
export interface RepeatPreset {
  label: string;
  rule: string;
}

/** The preset cadences, in menu order. Weekly presets omit BYDAY so the seed's own due
 *  weekday anchors them (DTSTART = due date, resolved in core/domain.RepeatAnchor). */
export const REPEAT_PRESETS: RepeatPreset[] = [
  { label: "Does not repeat", rule: "" },
  { label: "Every day", rule: "FREQ=DAILY" },
  { label: "Every weekday", rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { label: "Every week", rule: "FREQ=WEEKLY" },
  { label: "Every 2 weeks", rule: "FREQ=WEEKLY;INTERVAL=2" },
  { label: "Every month", rule: "FREQ=MONTHLY" },
  { label: "Every year", rule: "FREQ=YEARLY" },
];

const WEEKDAY_NAMES: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
const ORDINALS: Record<string, string> = { "1": "1st", "2": "2nd", "3": "3rd", "4": "4th", "5": "5th", "-1": "last" };
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A human-readable label for a stored RRULE — the matching preset when there is one, else a
 *  description built from the rule's parts (weekday lists, ordinal weekday-of-month, day of
 *  month, yearly date, intervals) so a custom or natural-language rule reads honestly rather
 *  than collapsing to a bare "Every month". */
export function repeatLabel(rule?: string | null): string | null {
  if (!rule || !rule.trim()) return null;
  const normalized = rule.trim().replace(/^RRULE:/i, "").toUpperCase();
  const preset = REPEAT_PRESETS.find((p) => p.rule && p.rule.toUpperCase() === normalized);
  if (preset) return preset.label;

  const parts = Object.fromEntries(normalized.split(";").map((kv) => kv.split("="))) as Record<string, string>;
  const freq = parts.FREQ;
  const interval = Number(parts.INTERVAL ?? "1");
  const unit: Record<string, string> = { MINUTELY: "minute", HOURLY: "hour", DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };
  const every = interval > 1 ? `Every ${interval} ${unit[freq] ?? "time"}s` : `Every ${unit[freq] ?? "time"}`;

  if (freq === "WEEKLY" && parts.BYDAY) {
    const codes = parts.BYDAY.split(",");
    if (codes.join(",") === "MO,TU,WE,TH,FR") return interval > 1 ? `${every} on weekdays` : "Every weekday";
    if (codes.join(",") === "SA,SU") return interval > 1 ? `${every} on weekends` : "Every weekend";
    const names = codes.map((c) => WEEKDAY_NAMES[c] ?? c).join(", ");
    return `${every} on ${names}`;
  }
  if (freq === "MONTHLY" && parts.BYDAY) {
    // Ordinal weekday of month, e.g. "3WE" → "3rd Wednesday", "-1FR" → "last Friday".
    const m = /^(-?\d+)([A-Z]{2})$/.exec(parts.BYDAY);
    if (m) return `${every} on the ${ORDINALS[m[1]] ?? m[1]} ${WEEKDAY_NAMES[m[2]] ?? m[2]}`;
  }
  if (freq === "MONTHLY" && parts.BYMONTHDAY) {
    const days = parts.BYMONTHDAY.split(",").map((d) => (d === "-1" ? "last day" : `${d}${ordinalSuffix(d)}`));
    return `${every} on the ${days.join(" & ")}`;
  }
  if (freq === "YEARLY" && parts.BYMONTH) {
    const month = MONTH_NAMES[Number(parts.BYMONTH)] ?? "";
    return parts.BYMONTHDAY ? `Every ${month} ${parts.BYMONTHDAY}` : `Every ${month}`;
  }
  return freq ? every : "Repeats";
}

/** Subtitle for a repeating definition (seed): its cadence plus the next occurrence date,
 *  e.g. "Every week · next Jul 12". Shared by the root task list and project task lists so
 *  repeating tasks read the same everywhere. */
export function repeatSubtitle(rule?: string | null, next?: string | null): string {
  const cadence = repeatLabel(rule) ?? "Repeats";
  if (!next) return cadence;
  const d = new Date(next);
  if (Number.isNaN(d.getTime())) return cadence;
  return `${cadence} · next ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** English ordinal suffix for a day-of-month number ("1"→"st", "22"→"nd"). */
function ordinalSuffix(day: string): string {
  const n = Math.abs(Number(day));
  if (n >= 11 && n <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

// --- repeating projects (PLAN-scheduling.md §3) ---------------------------------------------
//
// A project repeats one of two ways: a fixed interval after it is completed ("P3D", "P2W",
// "P1M", "P1Y"), or on a plain schedule — every day, week or month, optionally until an end
// date — stored as an RRULE like a task's.

export type RepeatAfterUnit = "D" | "W" | "M" | "Y";
export const REPEAT_AFTER_UNITS: { unit: RepeatAfterUnit; label: string }[] = [
  { unit: "D", label: "days" },
  { unit: "W", label: "weeks" },
  { unit: "M", label: "months" },
  { unit: "Y", label: "years" },
];

export type ProjectRepeatFreq = "DAILY" | "WEEKLY" | "MONTHLY";
export const PROJECT_REPEAT_FREQS: { freq: ProjectRepeatFreq; label: string }[] = [
  { freq: "DAILY", label: "Every day" },
  { freq: "WEEKLY", label: "Every week" },
  { freq: "MONTHLY", label: "Every month" },
];

/** "P2W" → { n: 2, unit: "W" }; null when it isn't an after-completion interval. */
export function parseRepeatAfter(value?: string | null): { n: number; unit: RepeatAfterUnit } | null {
  const m = /^P(\d+)([DWMY])$/i.exec(value?.trim() ?? "");
  return m ? { n: Number(m[1]), unit: m[2].toUpperCase() as RepeatAfterUnit } : null;
}

export function formatRepeatAfter(n: number, unit: RepeatAfterUnit): string {
  return `P${Math.max(1, Math.floor(n))}${unit}`;
}

/** A schedule rule's frequency and end date (the local 'YYYY-MM-DD' of its UNTIL, or ""). */
export function parseProjectRule(rule?: string | null): { freq: ProjectRepeatFreq | null; until: string } {
  const parts = Object.fromEntries((rule ?? "").trim().replace(/^RRULE:/i, "").toUpperCase().split(";").map((kv) => kv.split("="))) as Record<string, string>;
  const freq = parts.FREQ === "DAILY" || parts.FREQ === "WEEKLY" || parts.FREQ === "MONTHLY" ? parts.FREQ : null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(parts.UNTIL ?? "");
  if (!m) return { freq, until: "" };
  const at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const p = (n: number) => String(n).padStart(2, "0");
  return { freq, until: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` };
}

/** Build a schedule rule. `until` is a local 'YYYY-MM-DD' (or "" for no end): the rule runs
 *  through the end of that day. */
export function buildProjectRule(freq: ProjectRepeatFreq, until: string): string {
  if (!until) return `FREQ=${freq}`;
  const [y, m, d] = until.split("-").map(Number);
  const end = new Date(y, m - 1, d, 23, 59, 59);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${end.getUTCFullYear()}${p(end.getUTCMonth() + 1)}${p(end.getUTCDate())}T${p(end.getUTCHours())}${p(end.getUTCMinutes())}${p(end.getUTCSeconds())}Z`;
  return `FREQ=${freq};UNTIL=${stamp}`;
}

/** How a project repeats, in words — "3 weeks after completion", "every week until Dec 1" —
 *  or null when it doesn't. */
export function projectRepeatLabel(project: { repeatRule?: string | null; repeatAfter?: string | null }): string | null {
  const after = parseRepeatAfter(project.repeatAfter);
  if (after) {
    const unit = REPEAT_AFTER_UNITS.find((u) => u.unit === after.unit)?.label ?? "days";
    return `${after.n} ${after.n === 1 ? unit.slice(0, -1) : unit} after completion`;
  }
  const label = repeatLabel(project.repeatRule);
  if (!label) return null;
  const { until } = parseProjectRule(project.repeatRule);
  if (!until) return label.toLowerCase();
  const [y, m, d] = until.split("-").map(Number);
  return `${label.toLowerCase()} until ${new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
