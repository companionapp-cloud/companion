// Where exported files go is platform-specific, like picking a file to import (thingsSource.ts):
// the desktop asks for the native save panel — a filename for one file, a folder for several —
// and writes to disk itself; the browser can only download, so one file downloads as it is and
// several download as a single .zip. The desktop injects its sink; the browser one lives here.
import type { ExportFile } from "./types";
import { zip } from "./zip";

/** What's about to be exported, so the platform can ask the right question. */
export interface ExportPlan {
  /** How many files will be written. */
  count: number;
  /** The file's name when there's one; a name for the set ("Companion Export") when several. */
  suggestedName: string;
}

export interface ExportSink {
  write: (file: ExportFile) => Promise<void>;
  /** Finish. Resolves to the name of what was saved, for the UI: the file, or the folder (the
   *  .zip, in a browser) holding several. */
  close: () => Promise<string | null>;
  /** Give up partway: nothing more is coming. */
  abort: () => void;
}

/** Opens a sink for a plan; null when the user cancelled the panel. */
export type ExportSinkOpener = (plan: ExportPlan) => Promise<ExportSink | null>;

let injected: ExportSinkOpener | null = null;

/** Register the native sink (the desktop calls this at startup). */
export function setExportSinkOpener(fn: ExportSinkOpener): void {
  injected = fn;
}

export function openExportSink(plan: ExportPlan): Promise<ExportSink | null> {
  return injected ? injected(plan) : Promise.resolve(downloadSink(plan));
}

function download(file: ExportFile): void {
  const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The download reads the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadSink(plan: ExportPlan): ExportSink {
  const files: ExportFile[] = [];
  return {
    write: async (file) => {
      files.push(file);
    },
    close: async () => {
      if (!files.length) return null;
      const file = plan.count === 1 ? files[0] : { name: `${plan.suggestedName}.zip`, mime: "application/zip", data: zip(files) };
      download(file);
      return file.name;
    },
    abort: () => {
      files.length = 0;
    },
  };
}
