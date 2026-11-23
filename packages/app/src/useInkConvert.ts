import { useCallback, useEffect, useRef, useState } from "react";
import type { InkTranscript } from "@companion/core-bridge";
import type { EditorController } from "@companion/editor";
import { useCore } from "./CoreContext";

/** What the drawing bar shows for "Convert to text". */
export interface InkConvert {
  /** This device can read handwriting (the desktop app on a Mac). */
  available: boolean;
  busy: boolean;
  /** A short result line ("No handwriting found"), cleared after a few seconds. */
  message: string | null;
  convert: () => void;
}

/** Where the ink being converted lives: a note, or a notebook page. */
export interface InkConvertSource {
  /** The editor showing the ink; it puts the text in place and erases the strokes. */
  editor(): EditorController | null;
  /** Write any ink still held, resolving once the core has it. */
  flush(): Promise<void>;
  /** Read the stored ink; null when there is nothing to read yet (no note). */
  transcribe(): Promise<{ transcripts: InkTranscript[]; unread: string[] } | null>;
}

const MESSAGE_MS = 4000;

// Whether this device can read handwriting doesn't change while the app runs.
let availability: Promise<boolean> | null = null;

/** Convert handwriting to text (PLAN-drawing.md): the core reads the ink with the device's
 *  recognizer (Apple Vision), then the editor puts each piece of text where its ink sits and
 *  erases those strokes, as one undoable edit. The editor does the writing so an open note or
 *  page stays the one source of its own content. */
export function useInkConvert(source: InkConvertSource): InkConvert {
  const { noteInk } = useCore();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const src = useRef(source);
  src.current = source;

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
      const s = src.current;
      try {
        // The recognizer reads the ink as stored: hand it everything drawn so far.
        s.editor()?.inkFlush();
        await s.flush();
        const res = await s.transcribe();
        if (!res) return;
        if (res.transcripts.length === 0) {
          say(res.unread.length ? "Couldn't read the handwriting" : "No handwriting found");
          return;
        }
        s.editor()?.inkToText(res.transcripts.map((t) => ({ groupIds: t.groupIds, text: t.text })));
        say(res.unread.length ? "Converted · some ink left as drawing" : null);
      } catch (e) {
        say(e instanceof Error && e.message ? e.message : "Couldn't convert the handwriting");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }, [say]);

  return { available, busy, message, convert };
}
