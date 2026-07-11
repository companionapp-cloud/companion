// Picking an .ics file to upload is platform-specific: the web reads it with a DOM file
// input + FileReader (available here), while native shells inject a picker built on their
// document-picker + filesystem APIs (packages/app can't depend on expo). Mirrors how the
// blob store / notification scheduler are injected (PLAN §3.1).

export interface IcsFile {
  /** The chosen file's name, used to prefill the feed name. */
  name: string;
  /** The file's UTF-8 text contents (raw ICS). */
  text: string;
}

let injected: (() => Promise<IcsFile | null>) | null = null;

/** Register a native .ics picker (mobile calls this at startup). */
export function setIcsFilePicker(fn: () => Promise<IcsFile | null>): void {
  injected = fn;
}

/** Whether a file can be picked on this platform (native injected, or a DOM is present). */
export function canPickIcsFile(): boolean {
  return injected != null || typeof document !== "undefined";
}

/** Open the platform file dialog and read the chosen .ics as text, or null if cancelled. */
export async function pickIcsFile(): Promise<IcsFile | null> {
  if (injected) return injected();
  if (typeof document !== "undefined") return pickViaDom();
  return null;
}

/** Web: a hidden <input type="file"> + FileReader. Must run from a user gesture (it is —
 *  the settings "Upload .ics" button). */
function pickViaDom(): Promise<IcsFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ics,text/calendar";
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, text: String(reader.result ?? "") });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    // If the user dismisses the dialog no change fires; that's fine — the promise just stays
    // pending until the component unmounts, which is acceptable for a one-shot picker.
    document.body.appendChild(input);
    input.click();
  });
}
