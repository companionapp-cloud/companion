import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { colors } from "@companion/design-system";
import { Editor, type EditorController, type FormatState, type InkGroupRecord, type InkState, type InkTool } from "@companion/editor";
import type { NotebookDocument, NotebookGuide, NotebookHost, NotebookPage } from "./host";
import { PAGE, PAGE_GAP, paperBackground, paperTypographyCss, sheetHeightFor } from "./paper";

// SPIKE (PLAN-notebooks.md): the notebook's pages, DOM only, behind a NotebookHost the way the
// canvas sits behind CanvasHost, so the same component could be bundled into the native
// WebView. Each page is the real editor laid on a fixed-size sheet, with its ink layer in page
// mode (ink fixed to the sheet, not the text). Zoom is a CSS transform on the sheet, which the
// ink layer already measures and undoes.

const RULER = 20;
const STAGE_PAD = 32;
const PHONE_W = 640;

export type { NotebookZoom, NotebookViewState, NotebookViewController, NotebookViewProps } from "./viewTypes";
import type { NotebookViewController, NotebookViewProps } from "./viewTypes";

const STYLE_ID = "companion-notebook";
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.nb-root { position: absolute; inset: 0; display: flex; flex-direction: column; background: ${colors.surfaceSunken}; }
.nb-stage { position: relative; flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.nb-flow { display: flex; gap: ${PAGE_GAP}px; padding: ${STAGE_PAD}px; box-sizing: border-box; min-width: min-content; min-height: 100%; }
.nb-flow[data-mode="spread"] { flex-direction: row; justify-content: center; align-items: flex-start; }
.nb-flow[data-mode="scroll"] { flex-direction: column; align-items: center; }
.nb-rulers .nb-flow { padding-top: ${STAGE_PAD + RULER}px; padding-left: ${STAGE_PAD + RULER}px; }
.nb-slot { position: relative; flex-shrink: 0; }
.nb-sheet {
  position: absolute; left: 0; top: 0; transform-origin: 0 0; box-sizing: border-box; overflow: hidden;
  width: ${PAGE.width}px; padding: ${PAGE.marginTop}px ${PAGE.marginX}px ${PAGE.marginBottom}px;
  background-color: ${colors.surfaceCard}; border-radius: 3px;
  box-shadow: 0 0 0 1px ${colors.borderSubtle}, 0 6px 20px rgba(17, 17, 16, 0.08);
  --nb-text-min: ${PAGE.height - PAGE.marginTop - PAGE.marginBottom}px;
}
.nb-sheet[data-active="true"] { box-shadow: 0 0 0 1px ${colors.borderDefault}, 0 8px 26px rgba(17, 17, 16, 0.12); }
.nb-sheet .pm-ink { left: -${PAGE.marginX}px; top: -${PAGE.marginTop}px; width: calc(100% + ${PAGE.marginX * 2}px); height: var(--nb-sheet-h); border-radius: 0; }
.nb-sheet .pm-ink-drawing .pm-ink-under { background: transparent; }
.nb-sheet .pm-ink-drawing .pm-ink-over { outline: none; }
.nb-folio { position: absolute; left: 0; right: 0; bottom: 18px; text-align: center; font: 500 10px ${"'Geist Mono', ui-monospace, monospace"}; color: ${colors.textQuaternary}; pointer-events: none; }
.nb-blank { border: 1px dashed ${colors.borderDefault}; border-radius: 3px; display: flex; align-items: center; justify-content: center; color: ${colors.textTertiary}; font: 500 12px Geist, system-ui, sans-serif; cursor: pointer; background: transparent; }
.nb-blank:hover { background: ${colors.surfaceHover}; }
.nb-ghost { background: ${colors.surfaceCard}; border-radius: 3px; box-shadow: 0 0 0 1px ${colors.borderSubtle}; }
.nb-guide { position: absolute; background: ${colors.accent}; opacity: 0.75; z-index: 3; }
.nb-guide[data-axis="x"] { top: 0; bottom: 0; width: 1px; cursor: col-resize; }
.nb-guide[data-axis="y"] { left: 0; right: 0; height: 1px; cursor: row-resize; }
.nb-guide::after { content: ""; position: absolute; inset: -4px; }
.nb-ruler { position: absolute; z-index: 5; background: ${colors.surfaceApp}; color: ${colors.textTertiary}; user-select: none; -webkit-user-select: none; touch-action: none; }
.nb-ruler-x { left: ${RULER}px; right: 0; top: 0; height: ${RULER}px; border-bottom: 1px solid ${colors.borderSubtle}; cursor: row-resize; }
.nb-ruler-y { top: ${RULER}px; bottom: 0; left: 0; width: ${RULER}px; border-right: 1px solid ${colors.borderSubtle}; cursor: col-resize; }
.nb-ruler-corner { position: absolute; z-index: 6; left: 0; top: 0; width: ${RULER}px; height: ${RULER}px; background: ${colors.surfaceApp}; border-right: 1px solid ${colors.borderSubtle}; border-bottom: 1px solid ${colors.borderSubtle}; box-sizing: border-box; }
.nb-ruler svg { display: block; }
.nb-ruler text { font: 500 8px 'Geist Mono', ui-monospace, monospace; fill: currentColor; }
.nb-ruler line { stroke: currentColor; stroke-width: 1; opacity: 0.6; }
.nb-ruler .nb-ruler-page { fill: ${colors.surfaceCard}; }
.nb-draft { position: absolute; z-index: 7; background: ${colors.accent}; pointer-events: none; }
${paperTypographyCss()}
`;
  document.head.appendChild(el);
}

/** One page: loads its note and ink from the host and lays the editor on a sheet. */
function PageSheet({
  host,
  page,
  index,
  scale,
  tool,
  penTool,
  active,
  guides,
  showGuides,
  onActivate,
  onEditor,
  onFormatState,
  onInkState,
  onExitDrawing,
  onPinch,
  onGuideDrag,
  onHeight,
}: {
  host: NotebookHost;
  page: NotebookPage;
  index: number;
  scale: number;
  tool: InkTool | null;
  penTool: InkTool | null;
  active: boolean;
  guides: NotebookGuide[];
  showGuides: boolean;
  onActivate(): void;
  onEditor(ctrl: EditorController | null): void;
  onFormatState(state: FormatState): void;
  onInkState(state: InkState): void;
  onExitDrawing(): void;
  onPinch(factor: number): void;
  onGuideDrag(guide: NotebookGuide, e: ReactPointerEvent): void;
  onHeight(pageId: string, height: number): void;
}) {
  const [loaded, setLoaded] = useState<{ md: string; ink: InkGroupRecord[] } | null>(null);
  const [ink, setInk] = useState<InkGroupRecord[]>([]);
  const [textHeight, setTextHeight] = useState<number>(PAGE.height);
  const [inkBottom, setInkBottom] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    void Promise.all([host.loadPage(page.id), host.loadInk(page.id)]).then(([text, groups]) => {
      if (!live) return;
      setInk(groups);
      setLoaded({ md: text.contentMd, ink: groups });
    });
    return () => {
      live = false;
    };
  }, [host, page.id]);

  // The sheet grows by whole rules when the text runs past the bottom margin, and never
  // shrinks above its lowest ink.
  useEffect(() => {
    const pm = sheetRef.current?.querySelector<HTMLElement>(".ProseMirror");
    if (!pm || !loaded) return;
    const measure = () => setTextHeight(sheetHeightFor(pm.offsetHeight, page.paper.spacing));
    // Also run on every reported edit: a hidden page delivers no resize observations.
    measureRef.current = measure;
    const ro = new ResizeObserver(measure);
    ro.observe(pm);
    measure();
    return () => ro.disconnect();
  }, [loaded, page.paper.spacing, page.id]);
  const height = Math.max(textHeight, sheetHeightFor(inkBottom - PAGE.marginTop - PAGE.marginBottom / 2, page.paper.spacing));
  useEffect(() => {
    onHeight(page.id, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, height]);

  const sheetStyle: CSSProperties = {
    height,
    ["--nb-sheet-h" as string]: `${height}px`,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    ...paperBackground(page.paper, colors.borderDefault, colors.textQuaternary, colors.surfaceCard, scale),
  };

  return (
    <div className="nb-slot" style={{ width: PAGE.width * scale, height: height * scale }} data-page={index}>
      <div
        ref={sheetRef}
        className="nb-sheet"
        data-spacing={page.paper.spacing}
        data-active={active}
        style={sheetStyle}
        onPointerDownCapture={onActivate}
        onFocusCapture={onActivate}
      >
        {loaded ? (
          <Editor
            ref={onEditor}
            markdown={loaded.md}
            onChangeMarkdown={(md) => {
              measureRef.current();
              void host.savePage(page.id, md);
            }}
            onFormatStateChange={(s) => active && onFormatState(s)}
            placeholder=""
            ink={{
              groups: ink,
              tool,
              penTool,
              // Fixed to the sheet; the view routes undo, since a spread has two layers on screen.
              page: true,
              keyboard: false,
              onSave: (groups) => {
                setInk((prev) => {
                  const ids = new Set(groups.map((g) => g.id));
                  return [...prev.filter((g) => !ids.has(g.id)), ...groups];
                });
                void host.saveInk(page.id, groups);
              },
              onDelete: (ids) => {
                setInk((prev) => prev.filter((g) => !ids.includes(g.id)));
                void host.deleteInk(page.id, ids);
              },
              onStateChange: (s) => {
                setInkBottom(s.inkBottom ?? 0);
                if (active) onInkState(s);
              },
              onExitRequest: onExitDrawing,
              onPinch: (f) => onPinch(f),
            }}
          />
        ) : null}
        <div className="nb-folio">{index + 1}</div>
        {showGuides
          ? guides.map((g) => (
              <div
                key={g.id}
                className="nb-guide"
                data-axis={g.axis}
                style={g.axis === "x" ? { left: g.at } : { top: g.at }}
                onPointerDown={(e) => onGuideDrag(g, e)}
              />
            ))
          : null}
      </div>
    </div>
  );
}

/** Ruler ticks for one axis, in page units, drawn from the active page's origin. */
function RulerTicks({ axis, origin, length, scale, pageSize }: { axis: "x" | "y"; origin: number; length: number; scale: number; pageSize: number }) {
  // Keep labels ~60 screen px apart whatever the zoom.
  const step = [10, 20, 50, 100, 200, 500].find((s) => s * scale >= 56) ?? 500;
  const minor = step / 5;
  const from = Math.floor(-origin / scale / minor) * minor;
  const to = (length - origin) / scale;
  const ticks: React.ReactNode[] = [];
  for (let v = from; v <= to; v += minor) {
    const at = Math.round(origin + v * scale) + 0.5;
    const major = Math.round(v) % step === 0;
    const len = major ? 9 : 4;
    ticks.push(
      axis === "x" ? (
        <line key={v} x1={at} x2={at} y1={RULER - len} y2={RULER} />
      ) : (
        <line key={v} y1={at} y2={at} x1={RULER - len} x2={RULER} />
      ),
    );
    if (major) {
      ticks.push(
        axis === "x" ? (
          <text key={`t${v}`} x={at + 2} y={8}>
            {Math.round(v)}
          </text>
        ) : (
          <text key={`t${v}`} x={8} y={at - 2} transform={`rotate(-90 8 ${at - 2})`}>
            {Math.round(v)}
          </text>
        ),
      );
    }
  }
  const pageRect =
    axis === "x" ? (
      <rect className="nb-ruler-page" x={origin} y={0} width={pageSize * scale} height={RULER} />
    ) : (
      <rect className="nb-ruler-page" y={origin} x={0} height={pageSize * scale} width={RULER} />
    );
  return (
    <svg width={axis === "x" ? length : RULER} height={axis === "x" ? RULER : length}>
      {pageRect}
      {ticks}
    </svg>
  );
}

export const NotebookView = forwardRef<NotebookViewController, NotebookViewProps>(function NotebookView(
  { host, notebookId, mode, zoom, onZoom, tool, penTool, rulers, revision, onState, onActivePage, onFormatState, onInkState, onExitDrawing },
  ref,
) {
  ensureStyles();
  const [doc, setDoc] = useState<NotebookDocument | null>(null);
  const [current, setCurrent] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [near, setNear] = useState<Set<number>>(() => new Set([0, 1]));
  const [draft, setDraft] = useState<{ axis: "x" | "y"; client: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const editors = useRef(new Map<string, EditorController>());
  const heights = useRef(new Map<string, number>());
  const [, bumpHeights] = useState(0);

  const reload = useCallback(async () => {
    const d = await host.load(notebookId);
    setDoc(d);
    return d;
  }, [host, notebookId]);
  useEffect(() => {
    void reload();
  }, [reload, revision]);

  const pages = doc?.pages ?? [];
  const guides = doc?.notebook.guides ?? [];

  // Stage size, for fit zoom and the rulers.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const across = mode === "spread" ? 2 : 1;
  const fitScale = useMemo(() => {
    if (!stage.w) return 1;
    // A phone fits the text column, not the sheet: the side margins scroll off either edge.
    if (stage.w < PHONE_W) return stage.w / (PAGE.width - PAGE.marginX * 2 + 32);
    const chrome = STAGE_PAD * 2 + (rulers ? RULER : 0) + (across - 1) * PAGE_GAP;
    const byWidth = (stage.w - chrome) / (PAGE.width * across);
    // A spread shows whole pages; a scrolling list only fits the width.
    const byHeight = mode === "spread" ? (stage.h - STAGE_PAD * 2 - (rulers ? RULER : 0)) / PAGE.height : Infinity;
    return Math.max(0.25, Math.min(byWidth, byHeight, 2));
  }, [stage, rulers, across, mode]);
  const scale = zoom === "fit" ? fitScale : zoom;

  // The pages on screen: a spread's pair, or every page of the list.
  const spreadStart = current - (current % 2);
  const visible = mode === "spread" ? pages.slice(spreadStart, spreadStart + 2) : pages;
  const visibleOffset = mode === "spread" ? spreadStart : 0;

  const activePage = pages.find((p) => p.id === activeId) ?? visible[0] ?? null;
  useEffect(() => {
    onActivePage(activePage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage?.id, activePage?.paper.kind, activePage?.paper.spacing]);

  useEffect(() => {
    onState({ page: mode === "spread" ? spreadStart : current, pageCount: pages.length, scale });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, spreadStart, pages.length, scale, mode]);

  // Scrolling list: the current page is the one crossing the middle of the stage, and only
  // pages near the viewport mount an editor (the rest are blank sheets of the right height).
  const onScroll = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    setScroll({ x: el.scrollLeft, y: el.scrollTop });
    if (mode !== "scroll") return;
    const mid = el.getBoundingClientRect().top + el.clientHeight / 2;
    const slots = el.querySelectorAll<HTMLElement>("[data-page]");
    let best = 0;
    const next = new Set<number>();
    slots.forEach((s) => {
      const r = s.getBoundingClientRect();
      const i = Number(s.dataset.page);
      if (r.top <= mid) best = i;
      if (r.bottom > -el.clientHeight && r.top < el.clientHeight * 2) next.add(i);
    });
    setCurrent(best);
    setNear((prev) => (prev.size === next.size && [...next].every((i) => prev.has(i)) ? prev : next));
  }, [mode]);
  useEffect(() => {
    onScroll();
  }, [onScroll, pages.length, scale]);

  // Phone fit leaves the sheet wider than the screen: start centred on the text column.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || zoom !== "fit" || stage.w >= PHONE_W) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [zoom, stage.w, scale, doc]);

  const goTo = useCallback(
    (page: number) => {
      const i = Math.max(0, Math.min(page, pages.length - 1));
      setCurrent(i);
      if (pages[i]) setActiveId(pages[i].id);
      if (mode === "scroll") {
        const el = stageRef.current?.querySelector<HTMLElement>(`[data-page="${i}"]`);
        el?.scrollIntoView({ block: "start" });
        stageRef.current?.scrollBy({ top: -(STAGE_PAD / 2 + (rulers ? RULER : 0)) });
      }
    },
    [pages, mode, rulers],
  );

  const addPage = useCallback(async () => {
    const after = activePage ?? pages[pages.length - 1] ?? null;
    // A new page takes the paper of the page you are on.
    const made = await host.addPage(notebookId, after?.id ?? null, after?.paper ?? { kind: "lined", spacing: 28 });
    const d = await reload();
    const i = d.pages.findIndex((p) => p.id === made.id);
    setActiveId(made.id);
    setCurrent(i);
    if (mode === "scroll") requestAnimationFrame(() => stageRef.current?.querySelector<HTMLElement>(`[data-page="${i}"]`)?.scrollIntoView({ block: "start" }));
  }, [activePage, pages, host, notebookId, reload, mode]);

  useImperativeHandle(
    ref,
    () => ({
      goTo,
      addPage: () => void addPage(),
      editor: () => (activePage ? (editors.current.get(activePage.id) ?? null) : null),
    }),
    [goTo, addPage, activePage],
  );

  // Undo, redo and Escape while drawing go to the current page only. Each ink layer would
  // otherwise answer the same key (a spread has two on screen), so they are told not to listen.
  useEffect(() => {
    if (!tool) return;
    const onKey = (e: KeyboardEvent) => {
      const ctrl = activePage ? editors.current.get(activePage.id) : null;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && (key === "z" || key === "y")) {
        e.preventDefault();
        if (key === "y" || e.shiftKey) ctrl?.inkRedo();
        else ctrl?.inkUndo();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onExitDrawing();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, activePage, onExitDrawing]);

  // Trackpad pinch and ⌘/ctrl + wheel zoom. Spike: not yet anchored under the pointer (the
  // scroll offset isn't compensated), so the page drifts as it scales.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const next = Math.max(0.25, Math.min(4, scale * Math.exp(-e.deltaY * 0.01)));
      onZoom(Math.round(next * 100) / 100);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, onZoom]);

  // ---- rulers and guides -------------------------------------------------------------------

  /** The active sheet's top-left in stage-viewport px: the rulers' zero. */
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!rulers) return;
    const el = stageRef.current;
    const id = activePage?.id;
    const sheet = id ? el?.querySelector<HTMLElement>(`[data-sheet="${id}"] .nb-sheet`) : null;
    if (!el || !sheet) return;
    const s = sheet.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setOrigin({ x: s.left - r.left, y: s.top - r.top });
  }, [rulers, activePage?.id, scroll, scale, stage, mode, current, doc]);

  const saveGuides = useCallback(
    (next: NotebookGuide[]) => {
      setDoc((d) => (d ? { ...d, notebook: { ...d.notebook, guides: next } } : d));
      void host.setGuides(notebookId, next);
    },
    [host, notebookId],
  );

  /** Drag a guide: a new one out of a ruler, or an existing one. Dropping it back on a ruler
   *  (or off the page) removes it. */
  const dragGuide = useCallback(
    (axis: "x" | "y", id: string | null, e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = stageRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const o = origin;
      const size = axis === "x" ? PAGE.width : (activePage && heights.current.get(activePage.id)) || PAGE.height;
      const at = (ev: PointerEvent) => ((axis === "x" ? ev.clientX - r.left - o.x : ev.clientY - r.top - o.y) / scale);
      const move = (ev: PointerEvent) => setDraft({ axis, client: axis === "x" ? ev.clientX - r.left : ev.clientY - r.top });
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDraft(null);
        const v = Math.round(at(ev));
        const rest = guides.filter((g) => g.id !== id);
        if (v <= 0 || v >= size) saveGuides(rest);
        else saveGuides([...rest, { id: id ?? Math.random().toString(36).slice(2, 10), axis, at: v }]);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [origin, scale, guides, saveGuides, activePage],
  );

  return (
    <div className={rulers ? "nb-root nb-rulers" : "nb-root"}>
      <div ref={stageRef} className="nb-stage" onScroll={onScroll}>
        <div className="nb-flow" data-mode={mode}>
          {visible.map((page, i) => {
            const index = visibleOffset + i;
            const mounted = mode === "spread" || near.has(index);
            if (!mounted) {
              const h = heights.current.get(page.id) ?? PAGE.height;
              return <div key={page.id} className="nb-slot nb-ghost" data-page={index} style={{ width: PAGE.width * scale, height: h * scale }} />;
            }
            return (
              <div key={page.id} data-sheet={page.id} style={{ display: "contents" }}>
                <PageSheet
                  host={host}
                  page={page}
                  index={index}
                  scale={scale}
                  tool={tool}
                  penTool={penTool}
                  active={activePage?.id === page.id}
                  guides={guides}
                  showGuides={rulers}
                  onActivate={() => {
                    setActiveId(page.id);
                    if (mode === "spread") setCurrent(index);
                  }}
                  onEditor={(ctrl) => {
                    if (ctrl) editors.current.set(page.id, ctrl);
                    else editors.current.delete(page.id);
                  }}
                  onFormatState={onFormatState}
                  onInkState={onInkState}
                  onExitDrawing={onExitDrawing}
                  onPinch={(f) => onZoom(Math.round(Math.max(0.25, Math.min(4, scale * f)) * 1000) / 1000)}
                  onGuideDrag={(g, e) => dragGuide(g.axis, g.id, e)}
                  onHeight={(id, h) => {
                    if (heights.current.get(id) === h) return;
                    heights.current.set(id, h);
                    bumpHeights((n) => n + 1);
                  }}
                />
              </div>
            );
          })}
          {doc && mode === "spread" && visible.length === 1 ? (
            <button className="nb-slot nb-blank" style={{ width: PAGE.width * scale, height: PAGE.height * scale }} onClick={() => void addPage()}>
              Add page
            </button>
          ) : null}
        </div>
      </div>
      {rulers ? (
        <>
          <div className="nb-ruler nb-ruler-x" onPointerDown={(e) => dragGuide("y", null, e)}>
            <RulerTicks axis="x" origin={origin.x - RULER} length={Math.max(0, stage.w - RULER)} scale={scale} pageSize={PAGE.width} />
          </div>
          <div className="nb-ruler nb-ruler-y" onPointerDown={(e) => dragGuide("x", null, e)}>
            <RulerTicks
              axis="y"
              origin={origin.y - RULER}
              length={Math.max(0, stage.h - RULER)}
              scale={scale}
              pageSize={(activePage && heights.current.get(activePage.id)) || PAGE.height}
            />
          </div>
          <div className="nb-ruler-corner" />
          {draft ? (
            <div
              className="nb-draft"
              style={draft.axis === "x" ? { left: draft.client, top: RULER, bottom: 0, width: 1 } : { top: draft.client, left: RULER, right: 0, height: 1 }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
});
