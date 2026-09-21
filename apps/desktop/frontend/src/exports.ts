import { Events } from "@wailsio/runtime";
import type { ExportFormat, ExportMenuHost, ExportSinkOpener } from "@companion/app";

// Exporting on the desktop (apps/desktop/export.go). The shared app renders the files; this is the
// glue to the two native pieces: the save panel the files are written through, and the File ›
// Export menu.

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Files go where the native panel says: POST /export/begin shows it — a save panel for one file,
 *  a folder chooser for several — and answers with a token the writes that follow carry. The page
 *  never names a path; the Go side holds it. */
export const desktopExportSink: ExportSinkOpener = async ({ count, suggestedName }) => {
  const res = await fetch("/export/begin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count, name: suggestedName }),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error((await res.text()).trim() || "Couldn’t open the save panel.");
  const { token, location } = (await res.json()) as { token: string; location: string };
  const end = () => void fetch(`/export/end?token=${token}`, { method: "POST" }).catch(() => undefined);
  return {
    async write(file) {
      // The bytes ride as the raw body — no base64 — and as a typed array rather than a Blob,
      // which WebKit doesn't hand to a custom-scheme handler.
      const put = await fetch(`/export/write?token=${token}&name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file.data as BodyInit,
      });
      if (!put.ok) throw new Error((await put.text()).trim() || `Couldn’t write “${file.name}”.`);
    },
    async close() {
      end();
      return basename(location);
    },
    abort: end,
  };
};

/** File › Export: tell the Go side which formats apply to what this window shows, and hear which
 *  one was picked — an event the Go side dispatches to the focused window alone. */
export function desktopExportMenu(): ExportMenuHost {
  return {
    setFormats(formats) {
      void fetch("/export/menu", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ formats }) }).catch(() => undefined);
    },
    onRequest(handler) {
      return Events.On("export:request", (event: { data?: unknown }) => {
        // As with "table:action": the payload arrives bare, or wrapped in an array.
        const raw = Array.isArray(event?.data) ? event.data[0] : event?.data;
        const format = (raw as { format?: string } | undefined)?.format;
        if (format) handler(format as ExportFormat);
      });
    },
  };
}
