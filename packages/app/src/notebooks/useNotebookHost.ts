import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import type { NotebookGuide as CoreGuide, NotebookPageInk } from "@companion/core-bridge";
import type { InkGroupRecord } from "@companion/editor";
import { useCore } from "../CoreContext";
import { useSync } from "../SyncProvider";
import { useDocumentSource } from "../DocumentSourceContext";
import type { NotebookDocument, NotebookHost, NotebookPage } from "./host";
import type { PaperStyle } from "./paper";

// The platform-independent NotebookHost (PLAN-notebooks.md §5): wraps the notebooks.* core
// API, the document source (cover images) and the sync trigger. The web view uses it
// directly; the native screen forwards WebView RPC calls to it.
//
// Ink writes are held for a moment after inking stops, as useNoteInk does for notes: a write
// that lands while a sync is pushing the group's previous version is marked clean by that push
// and overwritten by the pull that follows, losing the strokes in between. Reads that arrive
// while ink is held here get the held groups overlaid, so a stale reload never clobbers them.

const SAVE_DEBOUNCE_MS = 3000;
const rev = (r: NotebookPageInk) => `${r.version}:${r.updatedAt}`;
const toRecord = (r: NotebookPageInk): InkGroupRecord => ({ id: r.id, data: r.data, rev: rev(r) });

interface HeldInk {
  saves: Map<string, Record<string, unknown>>;
  deletes: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

export function useNotebookHost(): NotebookHost {
  const { core, notebooks: api } = useCore();
  const { trigger: syncTrigger } = useSync();
  const documentSource = useDocumentSource();
  const docRef = useRef(documentSource);
  docRef.current = documentSource;
  const held = useRef(new Map<string, HeldInk>());

  const host = useMemo<NotebookHost>(() => {
    const flush = async (pageId: string) => {
      const h = held.current.get(pageId);
      if (!h) return;
      if (h.timer) clearTimeout(h.timer);
      held.current.delete(pageId);
      const saves = [...h.saves].map(([id, data]) => ({ id, data }));
      const deletes = [...h.deletes];
      try {
        if (saves.length) await api.ink.upsert(pageId, saves);
        if (deletes.length) await api.ink.remove(pageId, deletes);
      } catch (e) {
        console.error("notebook ink write failed", e);
      }
      if (saves.length || deletes.length) syncTrigger();
    };
    const schedule = (pageId: string) => {
      const h = held.current.get(pageId)!;
      if (h.timer) clearTimeout(h.timer);
      h.timer = setTimeout(() => void flush(pageId), SAVE_DEBOUNCE_MS);
    };
    const heldFor = (pageId: string) => {
      let h = held.current.get(pageId);
      if (!h) {
        h = { saves: new Map(), deletes: new Set(), timer: null };
        held.current.set(pageId, h);
      }
      return h;
    };
    const toPage = (p: { id: string; sortOrder: number; paperKind: PaperStyle["kind"]; paperSpacing: PaperStyle["spacing"] }): NotebookPage => ({
      id: p.id,
      position: p.sortOrder,
      paper: { kind: p.paperKind, spacing: p.paperSpacing },
    });

    return {
      async load(notebookId): Promise<NotebookDocument> {
        const doc = await api.get(notebookId);
        const settings = (doc.notebook.settingsJson ?? {}) as { guides?: CoreGuide[] };
        return {
          notebook: {
            id: doc.notebook.id,
            title: doc.notebook.title,
            cover: doc.notebook.coverDocumentId
              ? { kind: "image", color: doc.notebook.coverColor, documentId: doc.notebook.coverDocumentId }
              : { kind: "color", color: doc.notebook.coverColor },
            guides: Array.isArray(settings.guides) ? settings.guides : [],
            pageCount: doc.pages.length,
            updatedAt: doc.notebook.updatedAt,
          },
          pages: doc.pages.map(toPage),
        };
      },
      async loadPage(pageId) {
        const p = await api.pages.get(pageId);
        return { contentMd: p.contentMd };
      },
      async savePage(pageId, contentMd) {
        await api.pages.update(pageId, { contentMd });
        syncTrigger();
      },
      async loadInk(pageId) {
        const rows = (await api.ink.list(pageId)).map(toRecord);
        const h = held.current.get(pageId);
        if (!h) return rows;
        const seen = new Set<string>();
        const out: InkGroupRecord[] = [];
        for (const r of rows) {
          if (h.deletes.has(r.id)) continue;
          seen.add(r.id);
          const data = h.saves.get(r.id);
          out.push(data ? { id: r.id, data } : r);
        }
        for (const [id, data] of h.saves) if (!seen.has(id)) out.push({ id, data });
        return out;
      },
      async saveInk(pageId, groups) {
        const h = heldFor(pageId);
        for (const g of groups) {
          h.saves.set(g.id, g.data);
          h.deletes.delete(g.id);
        }
        schedule(pageId);
      },
      async deleteInk(pageId, ids) {
        const h = heldFor(pageId);
        for (const id of ids) {
          h.saves.delete(id);
          h.deletes.add(id);
        }
        schedule(pageId);
      },
      async addPage(notebookId, afterPageId, paper) {
        const p = await api.pages.add({ notebookId, afterId: afterPageId ?? undefined, paperKind: paper.kind, paperSpacing: paper.spacing });
        syncTrigger();
        return toPage(p);
      },
      async setPaper(pageId, paper) {
        await api.pages.update(pageId, { paperKind: paper.kind, paperSpacing: paper.spacing });
        syncTrigger();
      },
      async deletePage(pageId) {
        await flush(pageId);
        await api.pages.remove(pageId);
        syncTrigger();
      },
      async setGuides(notebookId, guides) {
        await api.update(notebookId, { settingsJson: { guides } });
        syncTrigger();
      },
      async resolveDocument(id) {
        const r = await docRef.current?.resolveUrl(id);
        return r ? { url: r.url } : null;
      },
      /** Write every held ink group now (leaving the notebook, backgrounding the app). */
      async flushInk() {
        await Promise.all([...held.current.keys()].map(flush));
      },
    } as NotebookHost & { flushInk(): Promise<void> };
  }, [api, syncTrigger]);

  // Held ink is written when the app leaves the foreground and when the host goes away.
  useEffect(() => {
    const h = host as NotebookHost & { flushInk(): Promise<void> };
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") void h.flushInk();
    });
    return () => {
      sub.remove();
      void h.flushInk();
    };
  }, [host]);

  // Ink pulled by a sync for a page this device isn't holding: the view reloads it on
  // notebooks.ink.changed, which the core also emits for local writes (harmless echo).
  void core;
  return host;
}
