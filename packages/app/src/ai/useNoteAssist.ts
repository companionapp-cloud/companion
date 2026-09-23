import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AiGrammarResult, AiMetadataResult, AiTask, Note, ObjectProps } from "@companion/core-bridge";
import type { AiApplyMode, AiTarget, EditorController } from "@companion/editor";
import { useCore } from "../CoreContext";
import { useNotes } from "../NotesProvider";
import { assistFor } from "./assists";

// The note editor's writing-assist controller: captures what an assist acts on from the editor,
// runs it on the core (ai.run), follows its stream, and applies the result the reader picks.
// One assist at a time per editor; opening another releases the last one's target.

export type AssistPhase =
  /** Picking an assist (the AI toolbar button). */
  | { kind: "menu" }
  /** Supplying the assist's input: a prompt, a grade, a language. */
  | { kind: "compose"; task: AiTask }
  | { kind: "running"; task: AiTask }
  | { kind: "done"; task: AiTask; text: string; grammar?: AiGrammarResult; metadata?: AiMetadataResult }
  | { kind: "error"; task: AiTask; error: string };

export interface AssistParams {
  prompt?: string;
  grade?: number;
  language?: string;
}

export interface NoteAssist {
  /** Null while closed. */
  phase: AssistPhase | null;
  /** What the open assist acts on (null briefly while it's captured). */
  target: AiTarget | null;
  /** Streamed output so far (text assists). */
  stream: string;
  /** "agent · model" of the last run. */
  via: string | null;
  params: AssistParams;
  openMenu(): void;
  /** Open an assist; runs straight away when it needs no input. */
  start(task: AiTask): void;
  run(params?: AssistParams): void;
  stop(): void;
  close(): void;
  /** Put a text result into the note and close. */
  apply(mode: AiApplyMode, markdown?: string): void;
  /** Merge the chosen metadata fields into the note (setting its type if it had none) and close. */
  applyMetadata(keys: string[]): Promise<void>;
}

// Inputs remembered across assists for the session, so a second translation defaults to the
// language of the first.
const remembered: AssistParams = { grade: 8 };

const newRunId = () =>
  globalThis.crypto?.randomUUID?.() ?? `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function useNoteAssist({
  editorRef,
  note,
  title,
  onMetadataApplied,
}: {
  editorRef: RefObject<EditorController | null>;
  /** Null for a daily note nobody has typed in yet (it's created on the first write, which an
   *  applied result counts as). Only metadata needs the note itself. */
  note: Note | null;
  /** The title as currently typed (may be ahead of `note.title`). */
  title: string;
  onMetadataApplied?: () => void;
}): NoteAssist {
  const { ai } = useCore();
  const notes = useNotes();
  const [phase, setPhase] = useState<AssistPhase | null>(null);
  const [target, setTarget] = useState<AiTarget | null>(null);
  const [stream, setStream] = useState("");
  const [via, setVia] = useState<string | null>(null);
  const [params, setParams] = useState<AssistParams>(remembered);
  // The live run and target, read from event callbacks and cleanup. targetRef is the source of
  // truth; `target` mirrors it for rendering.
  const runRef = useRef<{ id: string; task: AiTask } | null>(null);
  const targetRef = useRef<AiTarget | null>(null);
  // Capture requests race each other (native answers asynchronously); only the latest counts.
  const captureSeq = useRef(0);
  const noteRef = useRef(note);
  noteRef.current = note;

  useEffect(() => {
    const offDelta = ai.onDelta((e) => {
      if (e.runId === runRef.current?.id) setStream((s) => s + e.text);
    });
    const offDone = ai.onDone((e) => {
      const run = runRef.current;
      if (e.runId !== run?.id) return;
      runRef.current = null;
      setVia([e.agent, e.model].filter(Boolean).join(" · "));
      setPhase({
        kind: "done",
        task: run.task,
        text: e.text,
        grammar: run.task === "grammar" ? (e.result as AiGrammarResult) : undefined,
        metadata: run.task === "metadata" ? (e.result as AiMetadataResult) : undefined,
      });
    });
    const offError = ai.onError((e) => {
      const run = runRef.current;
      if (e.runId !== run?.id) return;
      runRef.current = null;
      setPhase({ kind: "error", task: run.task, error: e.error });
    });
    return () => {
      offDelta();
      offDone();
      offError();
    };
  }, [ai]);

  const cancelRun = useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    if (run) void ai.cancel(run.id).catch(() => {});
  }, [ai]);

  const releaseTarget = useCallback(() => {
    const t = targetRef.current;
    if (t) editorRef.current?.aiRelease(t.id);
    targetRef.current = null;
    setTarget(null);
  }, [editorRef]);

  // Leaving the note (or the editor unmounting) abandons the assist.
  useEffect(
    () => () => {
      cancelRun();
      const t = targetRef.current;
      if (t) editorRef.current?.aiRelease(t.id);
    },
    [cancelRun, editorRef],
  );

  // Resolves to the captured target, or "stale" when a later capture (or close) superseded it.
  const capture = useCallback(async (): Promise<AiTarget | null | "stale"> => {
    cancelRun();
    releaseTarget();
    const seq = ++captureSeq.current;
    const t = (await editorRef.current?.aiCapture()) ?? null;
    if (seq !== captureSeq.current) {
      if (t) editorRef.current?.aiRelease(t.id);
      return "stale";
    }
    targetRef.current = t;
    setTarget(t);
    return t;
  }, [cancelRun, releaseTarget, editorRef]);

  const runWith = useCallback(
    (task: AiTask, t: AiTarget | null, p: AssistParams) => {
      if (!t) {
        setPhase({ kind: "error", task, error: "The editor isn't ready yet. Try again." });
        return;
      }
      if (task === "metadata" && !noteRef.current) {
        setPhase({ kind: "error", task, error: "Write something in this note first." });
        return;
      }
      Object.assign(remembered, p);
      setParams({ ...remembered });
      cancelRun();
      const id = newRunId();
      runRef.current = { id, task };
      setStream("");
      setPhase({ kind: "running", task });
      const n = noteRef.current;
      ai.run({
        runId: id,
        task,
        text: t.markdown,
        document: t.selection || task === "generate" ? t.document : undefined,
        selection: t.selection,
        title: title.trim() || undefined,
        prompt: p.prompt,
        grade: p.grade,
        language: p.language,
        objectTypeId: task === "metadata" ? n?.objectTypeId ?? null : undefined,
        kind: "note",
      })
        .then((ack) => {
          if (runRef.current?.id === id) setVia([ack.agent, ack.model].filter(Boolean).join(" · "));
        })
        .catch((err: unknown) => {
          if (runRef.current?.id !== id) return;
          runRef.current = null;
          setPhase({ kind: "error", task, error: err instanceof Error ? err.message : String(err) });
        });
    },
    [ai, cancelRun, title],
  );

  const openMenu = useCallback(() => {
    setPhase({ kind: "menu" });
    void capture();
  }, [capture]);

  const start = useCallback(
    (task: AiTask) => {
      const def = assistFor(task);
      // From the menu, keep the target captured when it opened (the selection the reader had
      // when they pressed the AI button); otherwise capture now.
      const fromMenu = phase?.kind === "menu" && targetRef.current;
      const go = (t: AiTarget | null) => {
        if (def.input === "none") runWith(task, t, {});
        else setPhase({ kind: "compose", task });
      };
      if (fromMenu) go(targetRef.current);
      else {
        if (def.input !== "none") setPhase({ kind: "compose", task });
        void capture().then((t) => {
          if (t !== "stale" && def.input === "none") go(t);
        });
      }
    },
    [phase, capture, runWith],
  );

  const run = useCallback(
    (p?: AssistParams) => {
      const task = phase && "task" in phase ? phase.task : null;
      if (!task) return;
      runWith(task, targetRef.current, p ?? params);
    },
    [phase, params, runWith],
  );

  const close = useCallback(() => {
    captureSeq.current++;
    cancelRun();
    releaseTarget();
    setPhase(null);
    setStream("");
  }, [cancelRun, releaseTarget]);

  const stop = useCallback(() => {
    const task = runRef.current?.task;
    cancelRun();
    if (task && assistFor(task).input !== "none") setPhase({ kind: "compose", task });
    else close();
  }, [cancelRun, close]);

  const apply = useCallback(
    (mode: AiApplyMode, markdown?: string) => {
      const t = targetRef.current;
      const text = markdown ?? (phase?.kind === "done" ? phase.text : "");
      if (t && text.trim()) editorRef.current?.aiApply(t.id, mode, text);
      close();
    },
    [phase, editorRef, close],
  );

  const applyMetadata = useCallback(
    async (keys: string[]) => {
      const n = noteRef.current;
      if (phase?.kind !== "done" || !phase.metadata || !n) return;
      const { objectTypeId, props } = phase.metadata;
      const typeChanged = objectTypeId !== n.objectTypeId;
      const base: ObjectProps = typeChanged ? {} : { ...(n.props ?? {}) };
      for (const k of keys) base[k] = props[k];
      try {
        await notes.update(n.id, typeChanged ? { objectTypeId, props: base } : { props: base });
        onMetadataApplied?.();
        close();
      } catch (err) {
        setPhase({ kind: "error", task: "metadata", error: err instanceof Error ? err.message : String(err) });
      }
    },
    [phase, notes, onMetadataApplied, close],
  );

  return { phase, target, stream, via, params, openMenu, start, run, stop, close, apply, applyMetadata };
}
