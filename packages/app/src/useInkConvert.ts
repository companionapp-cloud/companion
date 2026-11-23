import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { EditorController } from "@companion/editor";
import { useCore } from "./CoreContext";
import type { NoteInkStore } from "./useNoteInk";

/** What the drawing bar shows for "Convert to text". */
export interface InkConvert {
  /** This device can read handwriting (the desktop app on a Mac). */
  available: boolean;
  busy: boolean;
  /** A short result line ("No handwriting found"), cleared after a few seconds. */
  message: string | null;
  convert: () => void;
}

const MESSAGE_MS = 4000;

// Whether this device can read handwriting doesn't change while the app runs.
let availability: Promise<boolean> | null = null;

/** Convert a note's handwriting to text (PLAN-drawing.md): the core reads the ink with the
 *  device's recognizer (Apple Vision), then the editor puts each piece of text where its ink
 *  sits and erases those strokes, as one undoable edit. The editor does the writing so the open
 *  note stays the one source of its own content. */
export function useInkConvert(
  /** The note's id, read when converting (a daily note may only exist once its ink is saved). */
  noteId: () => string | null,
  editorRef: RefObject<EditorController | null>,
  ink: NoteInkStore,
): InkConvert {
  const { noteInk } = useCore();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    availability ??= noteInk
      .canTranscribe()
      .then((r) => !!r?.available)
      .catch(() => false);
    void availability.then((ok) => {
      if (alive) setAvailable(ok);
    });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [noteInk]);

  const say = useCallback((text: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(text);
    if (text) timer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  }, []);

  const convert = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    say(null);
    void (async () => {
      try {
        // The recognizer reads the ink as stored: hand it everything drawn so far.
        editorRef.current?.inkFlush();
        await ink.flush();
        const id = noteId();
        if (!id) return;
        const { transcripts, unread } = await noteInk.transcribe(id);
        if (transcripts.length === 0) {
          say(unread.length ? "Couldn't read the handwriting" : "No handwriting found");
          return;
        }
        editorRef.current?.inkToText(transcripts.map((t) => ({ groupIds: t.groupIds, text: t.text })));
        say(unread.length ? "Converted · some ink left as drawing" : null);
      } catch (e) {
        say(e instanceof Error && e.message ? e.message : "Couldn't convert the handwriting");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }, [noteId, editorRef, ink, noteInk, say]);

  return { available, busy, message, convert };
}
