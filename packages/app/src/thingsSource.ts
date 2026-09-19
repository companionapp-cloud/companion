// Choosing a Things database to import (PLAN §6.12) is platform-specific, like picking an .ics
// file (icsFile.ts): the desktop asks for the native open panel (it can pick the
// "Things Database.thingsdatabase" package whole), mobile uses its document picker, and the web
// reads files with a DOM file input and stages them in the wasm bridge so core reads the bytes
// by handle. Native shells inject their picker; the web one lives here.
import type { CoreBridge, ImportSource } from "@companion/core-bridge";

/** A picked database: what to hand core, a label for the UI, and how to let go of staged bytes. */
export interface PickedThingsSource {
  source: ImportSource;
  label: string;
  release?: () => void;
}

/** How a platform picks: the desktop's open panel (which can choose the database package whole),
 *  a phone's document picker (a file), or a browser upload. */
export type ThingsPickerKind = "panel" | "document" | "upload";

let injected: (() => Promise<PickedThingsSource | null>) | null = null;
let injectedKind: ThingsPickerKind = "upload";

/** Register a native picker (desktop and mobile call this at startup). */
export function setThingsSourcePicker(fn: () => Promise<PickedThingsSource | null>, kind: "panel" | "document"): void {
  injected = fn;
  injectedKind = kind;
}

/** Whether this platform can pick a database: an injected picker, or a DOM + a bridge that can
 *  stage files (web). */
export function canPickThingsSource(core: CoreBridge): boolean {
  return injected != null || (typeof document !== "undefined" && typeof core.stageFile === "function");
}

/** Which way this platform picks — the dialog words its instructions to match. */
export function thingsPickerKind(): ThingsPickerKind {
  return injected ? injectedKind : "upload";
}

/** Open the platform picker; null when cancelled. Must run from a user gesture. */
export async function pickThingsSource(core: CoreBridge): Promise<PickedThingsSource | null> {
  if (injected) return injected();
  if (typeof document !== "undefined" && core.stageFile) return pickViaDom(core);
  return null;
}

/** Web: a hidden multi-file input. It takes a .zip of the package (Safari zips a package you
 *  choose; Finder › Compress makes one), or main.sqlite with its main.sqlite-wal. */
function pickViaDom(core: CoreBridge): Promise<PickedThingsSource | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      if (!files.length || !core.stageFile) return resolve(null);
      const staged = await Promise.all(
        files.map(async (f) => ({ handle: core.stageFile!(f.name, new Uint8Array(await f.arrayBuffer())), name: f.name })),
      );
      resolve({
        source: { files: staged },
        label: files.map((f) => f.name).join(", "),
        release: () => staged.forEach((f) => core.releaseFile?.(f.handle)),
      });
    };
    document.body.appendChild(input);
    input.click();
  });
}
