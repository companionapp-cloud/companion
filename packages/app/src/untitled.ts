// A new note, task or canvas is created titled "Untitled note" (and so on) so it reads well in
// lists and links before it's named. Its editor shows that stand-in as an empty, focused title
// field, and a title cleared back to nothing saves the stand-in again.

export const UNTITLED = { note: "Untitled note", task: "Untitled task", canvas: "Untitled canvas" } as const;

// "Untitled" is what notes were created with before the kind was spelled out.
const STAND_INS = new Set<string>(["Untitled", ...Object.values(UNTITLED)]);

/** The title is blank or one of the stand-ins: nobody has named this item yet. */
export function isUntitled(title: string): boolean {
  const t = title.trim();
  return t === "" || STAND_INS.has(t);
}

/** What a title field shows for a stored title: nothing for a stand-in. */
export function titleFieldValue(title: string): string {
  return isUntitled(title) ? "" : title;
}

/** What to store for a title field's text: the stand-in the item had (or the kind's own) when
 *  the field is empty, so an unnamed item keeps saving the title it was created with. */
export function titleToSave(text: string, stored: string, kind: keyof typeof UNTITLED): string {
  if (text.trim()) return text;
  return isUntitled(stored) && stored.trim() ? stored : UNTITLED[kind];
}
