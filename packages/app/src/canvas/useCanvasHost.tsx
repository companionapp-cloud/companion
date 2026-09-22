import { useMemo, useRef, useState, type ReactNode } from "react";
import { Linking } from "react-native";
import type { CalendarItem, GraphNode } from "@companion/core-bridge";
import { useCore } from "../CoreContext";
import { useTasks } from "../TasksProvider";
import { useSync } from "../SyncProvider";
import { useDocumentSource } from "../DocumentSourceContext";
import { usePointerDrag } from "../DndContext";
import type { CanvasHost, CanvasRefKind } from "./host";
import { RefPicker } from "./RefPicker";
import { EventPicker } from "./EventPicker";
import { LinkPrompt } from "./LinkPrompt";

export interface CanvasHostOptions {
  /** Where an embedded entity opens. The web editor routes through the navigator; the
   *  native screen pushes React Navigation routes. */
  onOpenRef: (ref: { type: CanvasRefKind; id: string }) => void;
  /** Create and open a new board (⌘⇧N). Omit where the host can't navigate. */
  onNewCanvas?: () => void;
}

/** The platform-independent CanvasHost: wraps the core APIs, the tasks store, the
 *  document source, and the sync trigger, and owns the picker dialogs (note/task search,
 *  event search, link prompt) that resolve the host's pick* promises. The web editor hands
 *  the host straight to CanvasView; the native editor forwards WebView RPC calls to it. */
export function useCanvasHost({ onOpenRef, onNewCanvas }: CanvasHostOptions): { host: CanvasHost; dialogs: ReactNode } {
  const { core, canvases } = useCore();
  const tasks = useTasks();
  const { trigger: syncTrigger } = useSync();
  const documentSource = useDocumentSource();
  const [picker, setPicker] = useState<{ kind: "ref"; type: "note" | "task" } | { kind: "event" } | { kind: "link" } | null>(null);
  const pendingPick = useRef<((v: { id: string; label: string; data?: Record<string, unknown> } | null) => void) | null>(null);
  const pendingLink = useRef<((v: string | null) => void) | null>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const openRefRef = useRef(onOpenRef);
  openRefRef.current = onOpenRef;
  const newCanvasRef = useRef(onNewCanvas);
  newCanvasRef.current = onNewCanvas;
  const docRef = useRef(documentSource);
  docRef.current = documentSource;
  // The shell's drag layer (web/desktop): a card's grip carries its note or task off the board.
  const pointerDrag = usePointerDrag();
  const pointerDragRef = useRef(pointerDrag);
  pointerDragRef.current = pointerDrag;

  const host = useMemo<CanvasHost>(
    () => ({
      load: (id) => canvases.get(id),
      upsertNodes: async (id, nodes) => {
        const saved = await canvases.nodes.upsert(id, nodes);
        syncTrigger();
        return saved;
      },
      deleteNodes: async (id, ids) => {
        const res = await canvases.nodes.remove(id, ids);
        syncTrigger();
        return { edgeIds: res.edgeIds ?? [] };
      },
      upsertEdges: async (id, edges) => {
        const saved = await canvases.edges.upsert(id, edges);
        syncTrigger();
        return saved;
      },
      deleteEdges: async (id, ids) => {
        await canvases.edges.remove(id, ids);
        syncTrigger();
      },
      setView: async (id, view) => {
        await canvases.setView(id, view);
      },
      onChanged: (cb) => {
        const offCanvas = core.on("canvases.changed", (p) => cb((p as { canvasId?: string } | null)?.canvasId || null));
        // Embedded notes/tasks/events/files change under the board too.
        const offData = core.on("data.changed", (p) => {
          const t = (p as { entityType?: string } | null)?.entityType;
          if (t !== "canvas") cb(null);
        });
        return () => {
          offCanvas();
          offData();
        };
      },
      openRef: (ref) => openRefRef.current(ref),
      openUrl: (url) => {
        void Linking.openURL(url).catch(() => {});
      },
      setTaskStatus: (id, status) => tasksRef.current.setStatus(id, status),
      pickRef: (type) =>
        new Promise((resolve) => {
          pendingPick.current?.(null);
          pendingPick.current = resolve;
          setPicker(type === "event" ? { kind: "event" } : { kind: "ref", type });
        }),
      pickImage: async () => {
        const src = docRef.current;
        if (!src?.pick) return null;
        const picked = await src.pick();
        return picked ? { documentId: picked.id } : null;
      },
      ingestImage: docRef.current?.ingest
        ? async (file) => {
            const src = docRef.current;
            if (!src?.ingest) throw new Error("image ingestion unavailable");
            const doc = await src.ingest(file);
            syncTrigger();
            return { documentId: doc.id };
          }
        : undefined,
      resolveDocument: async (id) => {
        const src = docRef.current;
        if (!src) return null;
        const r = await src.resolveUrl(id);
        return r ? { url: r.url, mime: r.mime } : null;
      },
      pickLink: () =>
        new Promise((resolve) => {
          pendingLink.current?.(null);
          pendingLink.current = resolve;
          setPicker({ kind: "link" });
        }),
      linkPreview: (url) => canvases.linkPreview(url),
      newCanvas: onNewCanvas ? () => newCanvasRef.current?.() : undefined,
      dragRef: pointerDrag
        ? (ref, canvasId, x, y) =>
            pointerDragRef.current?.({ kind: ref.type, id: ref.id, label: ref.label, source: `canvas:${canvasId}` }, x, y)
        : undefined,
    }),
    // documentSource identity feeds the optional ingestImage; everything else reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvases, core, syncTrigger, !!documentSource?.ingest, !!onNewCanvas, !!pointerDrag],
  );

  const finishPick = (v: { id: string; label: string; data?: Record<string, unknown> } | null) => {
    pendingPick.current?.(v);
    pendingPick.current = null;
    setPicker(null);
  };
  const finishLink = (v: string | null) => {
    pendingLink.current?.(v);
    pendingLink.current = null;
    setPicker(null);
  };

  const dialogs: ReactNode = !picker ? null : picker.kind === "ref" ? (
    <RefPicker type={picker.type} onPick={(n: GraphNode) => finishPick({ id: n.id, label: n.title })} onClose={() => finishPick(null)} />
  ) : picker.kind === "event" ? (
    <EventPicker
      onPick={(it: CalendarItem) => finishPick({ id: it.sourceId, label: it.title, data: { title: it.title, startsAt: it.startsAt, endsAt: it.endsAt ?? null, allDay: it.allDay } })}
      onClose={() => finishPick(null)}
    />
  ) : (
    <LinkPrompt onSubmit={(url) => finishLink(url)} onClose={() => finishLink(null)} />
  );

  return { host, dialogs };
}
