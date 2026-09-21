// YAML frontmatter for the markdown export: a document's metadata — title, dates, a task's
// status and schedule, an archetype's properties — goes in a `---` block ahead of the body, where
// Obsidian, static-site generators and the like expect it, and the body stays the user's own
// markdown. Values are for machines first: ISO dates, lowercase enums, lists as YAML lists.

export type FrontmatterValue = string | number | boolean | string[] | null | undefined;

/** Instants, dates and the words YAML would read as something other than a string. */
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const PLAIN = /^[A-Za-z][A-Za-z0-9 _./()'-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|y|n|~)$/i;

/** A string as a YAML scalar: bare when that's unambiguous, else double-quoted (JSON's string
 *  syntax is YAML's). */
function scalar(value: string): string {
  if (ISO.test(value)) return value;
  if (PLAIN.test(value) && !RESERVED.test(value) && value === value.trim()) return value;
  return JSON.stringify(value);
}

const key = (k: string) => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k));

/** The `---` block for the given fields, in order; empty ones (null, "", []) are left out. Ends
 *  with a blank line, ready for the body. */
export function frontmatter(fields: [string, FrontmatterValue][]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of fields) {
    if (v === null || v === undefined || v === "" || seen.has(k)) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${key(k)}:`, ...v.map((item) => `  - ${scalar(item)}`));
    } else lines.push(`${key(k)}: ${typeof v === "string" ? scalar(v) : String(v)}`);
    seen.add(k);
  }
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/** An instant for frontmatter. The app keeps a date with no time as local midnight (see
 *  TaskEditor's formatWhen), which exports as the plain date it means; anything else keeps its
 *  full ISO instant. */
export function yamlDate(iso?: string | null): string | null {
  if (!iso) return null;
  // Already a plain date (a note's day, an archetype's date field): keep it as written.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return d.toISOString();
}
