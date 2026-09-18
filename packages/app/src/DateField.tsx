import { useEffect, useState } from "react";
import { Input } from "@companion/design-system";

export interface DateFieldProps {
  /** "YYYY-MM-DD" (kind "date") or "HH:MM" (kind "time"), in LOCAL terms; "" when unset. */
  value: string;
  onChange: (value: string) => void;
  kind: "date" | "time";
  ariaLabel?: string;
}

const SHAPE = { date: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, time: /^(\d{1,2}):(\d{2})$/ };

/** Native build: no OS date picker is bundled yet (it needs a native module), so this is a typed
 *  field — "2026-09-21" / "14:30" — that commits when the text is a real date or time and
 *  otherwise leaves the last good value in place. The web build (DateField.web.tsx) is a picker. */
export function DateField({ value, onChange, kind }: DateFieldProps) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const commit = (next: string) => {
    setText(next);
    const m = SHAPE[kind].exec(next.trim());
    if (!m) return;
    if (kind === "date") {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const probe = new Date(y, mo - 1, d);
      if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return; // Feb 30
      onChange(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
    } else {
      const [h, mi] = [Number(m[1]), Number(m[2])];
      if (h > 23 || mi > 59) return;
      onChange(`${m[1].padStart(2, "0")}:${m[2]}`);
    }
  };

  return (
    <Input
      mono
      value={text}
      onChangeText={commit}
      onBlur={() => setText(value)}
      placeholder={kind === "date" ? "YYYY-MM-DD" : "HH:MM"}
      autoCapitalize="none"
    />
  );
}
