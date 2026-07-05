import type { CoreBridge } from "./types";

/** A parsed natural-language date (mirrors core/dates.Result). `matched` is the substring
 *  that was understood, for echoing back to the user. */
export interface ParsedDate {
  at: string;
  matched: string;
}

/** Typed wrapper over dates.parse (PLAN §6.4). Natural-language parsing runs in Go via
 *  olebedev/when; the client passes its local `now` (with timezone offset) so relative
 *  phrases like "tomorrow at 3pm" resolve in the user's timezone. */
export function datesApi(core: CoreBridge) {
  return {
    parse: (text: string, ref?: string) =>
      core.invoke<ParsedDate | null>("dates.parse", { text, ref: ref ?? localNowWithOffset() }),
  };
}

export type DatesApi = ReturnType<typeof datesApi>;

/** Now as an RFC3339 string carrying the local UTC offset (not 'Z'), so the Go parser
 *  anchors relative/bare times to the user's wall clock. */
function localNowWithOffset(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const offMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offMin >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offMin) / 60));
  const om = pad(Math.abs(offMin) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}
