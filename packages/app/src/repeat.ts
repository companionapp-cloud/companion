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
