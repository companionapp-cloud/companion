import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { colors } from "@companion/design-system";
import { Editor, type EditorController, type FormatState, type InkGroupRecord, type InkState, type InkTool } from "@companion/editor";
import type { NotebookDocument, NotebookGuide, NotebookHost, NotebookPage } from "./host";
import { PAGE, PAGE_GAP, paperBackground, paperTypographyCss, sheetHeightFor } from "./paper";
import { MEDIUMS, SHERD_FABRICS, mediumCss, pageGeometry, sherdShape, type MediumToolId, type NotebookMedium } from "./mediums";
import { MediumSurface, seedOf } from "./mediumEngine";
import { sherdPicture } from "./mediumCovers";

// SPIKE (PLAN-notebooks.md): the notebook's pages, DOM only, behind a NotebookHost the way the
// canvas sits behind CanvasHost, so the same component could be bundled into the native
// WebView. Each page is the real editor laid on a fixed-size sheet, with its ink layer in page
// mode (ink fixed to the sheet, not the text). Zoom is a CSS transform on the sheet, which the
// ink layer already measures and undoes.
//
// The notebook's medium (mediums.ts, PLAN §11) decides what a page is: a paper sheet with the
// editor on it, or a clay tablet, wax leaf or sherd, which take a pen only and draw themselves
// (MediumSheet, mediumEngine.ts). Only paper grows.

const RULER = 20;
const STAGE_PAD = 32;
const PHONE_W = 640;
// How long smoothing a page flat takes on screen; held ink for it is dropped meanwhile.
const SMOOTH_MS = 650;
// A page turn: how long the leaving page flips for, and what counts as a swipe.
const TURN_MS = 420;
const SWIPE_MIN_PX = 56;
const SWIPE_MAX_MS = 700;

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
.nb-flow { position: relative; display: flex; gap: ${PAGE_GAP}px; padding: ${STAGE_PAD}px; box-sizing: border-box; min-width: min-content; min-height: 100%; perspective: 1800px; }
.nb-stage[data-swipe="true"] { touch-action: pan-y; }
.nb-flow[data-mode="spread"] { flex-direction: row; justify-content: center; align-items: flex-start; }
.nb-flow[data-mode="scroll"] { flex-direction: column; align-items: center; }
.nb-rulers .nb-flow { padding-top: ${STAGE_PAD + RULER}px; padding-left: ${STAGE_PAD + RULER}px; }
.nb-slot { position: relative; flex-shrink: 0; }
.nb-slot.nb-leaving { position: absolute; z-index: 4; pointer-events: none; animation-duration: ${TURN_MS}ms; animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1); animation-fill-mode: forwards; }
.nb-leaving[data-turn="flip-next"] { transform-origin: left center; animation-name: nb-flip-next; }
.nb-leaving[data-turn="flip-prev"] { transform-origin: right center; animation-name: nb-flip-prev; }
.nb-leaving[data-turn="fade"] { animation-name: nb-fade-out; }
.nb-leaving[data-turn^="flip"] .nb-sheet { box-shadow: 0 0 0 1px ${colors.borderDefault}, -12px 0 30px rgba(17, 17, 16, 0.18); }
.nb-slot.nb-entering { animation: nb-enter ${TURN_MS}ms cubic-bezier(0.2, 0, 0.2, 1) both; }
@keyframes nb-flip-next { from { transform: rotateY(0deg); } 55% { opacity: 1; } to { transform: rotateY(-100deg); opacity: 0; } }
@keyframes nb-flip-prev { from { transform: rotateY(0deg); } 55% { opacity: 1; } to { transform: rotateY(100deg); opacity: 0; } }
@keyframes nb-fade-out { to { opacity: 0; } }
@keyframes nb-enter { from { opacity: 0.35; } 40% { opacity: 0.35; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .nb-slot.nb-leaving { animation-duration: 1ms; } .nb-slot.nb-entering { animation: none; } }
.nb-sheet {
  position: absolute; left: 0; top: 0; transform-origin: 0 0; box-sizing: border-box; overflow: hidden;
  padding: var(--nb-mt) var(--nb-mx) var(--nb-mb);
  background-color: ${colors.surfaceCard}; border-radius: 3px;
  box-shadow: 0 0 0 1px ${colors.borderSubtle}, 0 6px 20px rgba(17, 17, 16, 0.08);
}
.nb-editor { display: contents; }
.nb-sheet[data-active="true"] { box-shadow: 0 0 0 1px ${colors.borderDefault}, 0 8px 26px rgba(17, 17, 16, 0.12); }
.nb-sheet .pm-ink { left: calc(-1 * var(--nb-mx)); top: calc(-1 * var(--nb-mt)); width: calc(100% + 2 * var(--nb-mx)); height: var(--nb-sheet-h); border-radius: 0; }
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
${mediumCss()}
`;
  document.head.appendChild(el);
}

/** Everything a page's sheet is told by the view, whatever it is made of. */
interface SheetProps {
  host: NotebookHost;
  medium: NotebookMedium;
  page: NotebookPage;
  index: number;
  scale: number;
  tool: InkTool | null;
  penTool: InkTool | null;
  /** The pen tool on clay, wax and sherds, and its size. */
  mediumTool: MediumToolId | null;
  mediumSize?: number;
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
  /** A page turn (spread mode): this page is leaving, pinned where it was and flipping or
   *  fading out, or entering the new spread. */
  leaving?: { left: number; top: number; turn: "flip-next" | "flip-prev" | "fade" };
  entering?: boolean;
  /** The page is being smoothed flat. */
  busy?: boolean;
  /** Wax, two-page view: this leaf is tied to the one on its right across the gap (page px). */
  bindAcross?: number;
}

/** A page of whatever the notebook is made of: paper types and draws, the rest take a pen. */
function Sheet(props: SheetProps) {
  return props.medium === "paper" ? <PageSheet {...props} /> : <MediumSheet {...props} />;
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
  leaving,
  entering,
}: SheetProps) {
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
    width: PAGE.width,
    height,
    ["--nb-sheet-h" as string]: `${height}px`,
    ["--nb-mx" as string]: `${PAGE.marginX}px`,
    ["--nb-mt" as string]: `${PAGE.marginTop}px`,
    ["--nb-mb" as string]: `${PAGE.marginBottom}px`,
    ["--nb-text-min" as string]: `${PAGE.height - PAGE.marginTop - PAGE.marginBottom}px`,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    ...paperBackground(page.paper, colors.borderDefault, colors.textQuaternary, colors.surfaceCard, scale),
  };

  return (
    <div
      className={leaving ? "nb-slot nb-leaving" : entering ? "nb-slot nb-entering" : "nb-slot"}
      style={{ width: PAGE.width * scale, height: height * scale, ...(leaving ? { left: leaving.left, top: leaving.top } : null) }}
      data-page={leaving ? undefined : index}
      data-turn={leaving?.turn}
    >
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


/** A page of clay, wax or pottery: a pen-only surface (mediumEngine.ts) that draws itself,
 *  its marks kept as the page's ink rows. The toolbar's undo reaches it through a stand-in
 *  editor controller. */
function MediumSheet({
  host,
  medium,
  page,
  index,
  scale,
  tool,
  mediumTool,
  mediumSize,
  active,
  guides,
  showGuides,
  onActivate,
  onEditor,
  onInkState,
  onGuideDrag,
  onHeight,
  leaving,
  entering,
  busy,
  bindAcross,
}: SheetProps) {
  const geom = pageGeometry(medium, page.id);
  const canvasHost = useRef<HTMLDivElement>(null);
  const surface = useRef<MediumSurface | null>(null);
  const live = useRef({ active, onActivate, onInkState });
  live.current = { active, onActivate, onInkState };

  useEffect(() => {
    const el = canvasHost.current;
    if (!el || medium === "paper") return;
    const s = new MediumSurface(el, {
      medium,
      pageId: page.id,
      geom,
      side: index % 2 === 0 ? "left" : "right",
      onSave: (g) => void host.saveInk(page.id, [g]),
      onDelete: (ids) => void host.deleteInk(page.id, ids),
      onState: (st) => {
        if (live.current.active) live.current.onInkState(st);
      },
      onActivate: () => live.current.onActivate(),
    });
    surface.current = s;
    let alive = true;
    void host.loadInk(page.id).then((groups) => {
      if (alive) s.setStrokes(groups);
    });
    onEditor({
      format() {},
      insertReference() {},
      insertTable() {},
      insertDocument() {},
      resolveQuickCreate() {},
      inkUndo: () => s.undo(),
      inkRedo: () => s.redo(),
    });
    return () => {
      alive = false;
      s.destroy();
      surface.current = null;
      onEditor(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, page.id, medium]);

  useEffect(() => {
    if (mediumTool) surface.current?.setTool(mediumTool);
  }, [mediumTool]);
  useEffect(() => {
    surface.current?.setSize(mediumSize ?? 1);
  }, [mediumSize]);
  // A finger draws only in drawing mode; a pen and a mouse always do.
  useEffect(() => {
    surface.current?.setTouchDraws(!!tool);
  }, [tool]);
  useEffect(() => {
    surface.current?.setRenderScale(scale * (window.devicePixelRatio || 1));
  }, [scale]);
  useEffect(() => {
    if (active) surface.current?.emitState();
  }, [active]);
  useEffect(() => {
    onHeight(page.id, geom.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, geom.height]);

  return (
    <div
      className={leaving ? "nb-slot nb-leaving" : entering ? "nb-slot nb-entering" : "nb-slot"}
      style={{ width: geom.width * scale, height: geom.height * scale, ...(leaving ? { left: leaving.left, top: leaving.top } : null) }}
      data-page={leaving ? undefined : index}
      data-turn={leaving?.turn}
      data-medium={medium}
    >
      <div
        className="nb-msheet"
        data-active={active}
        data-touch={!!tool}
        data-smoothing={!!busy}
        style={{ width: geom.width, height: geom.height, transform: scale === 1 ? undefined : `scale(${scale})` }}
        onPointerDownCapture={onActivate}
      >
        <div ref={canvasHost} style={{ position: "absolute", inset: 0 }} />
        {medium === "wax" ? <WaxBinding pageId={page.id} width={geom.width} height={geom.height} side={index % 2 === 0 ? "left" : "right"} across={bindAcross} /> : null}
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

/** The thongs that bind a wax codex: one through each cord hole (mediumEngine draws the holes
 *  at a third and two thirds down, 9 px in from the spine edge), wrapped round the spine edge.
 *  In the two-page view the left leaf also carries each thong across the gap to its partner and
 *  ties it off in a knot. */
function WaxBinding({ pageId, width, height, side, across }: { pageId: string; width: number; height: number; side: "left" | "right"; across?: number }) {
  const spine = side === "left" ? width : 0;
  const hx = side === "left" ? width - 9 : 9;
  const out = side === "left" ? 1 : -1;
  return (
    <svg className="nb-binding" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {[0.32, 0.68].map((f, k) => {
        const y = height * f;
        const id = `thong-${pageId}-${k}`;
        const gap = across ?? 0;
        const mid = spine + gap / 2;
        return (
          <g key={k}>
            <defs>
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1={y - 3} x2="0" y2={y + 3}>
                <stop offset="0" stopColor="#a8703f" />
                <stop offset="0.45" stopColor="#7a4522" />
                <stop offset="1" stopColor="#3f200d" />
              </linearGradient>
            </defs>
            {/* Through the hole and round the edge, with its shadow on the frame. */}
            <circle cx={hx} cy={y} r={3.8} fill="#120904" />
            <path d={`M ${hx} ${y + 2} L ${spine + out * 2} ${y + 2}`} stroke="rgba(20,8,2,0.35)" strokeWidth={8} strokeLinecap="round" fill="none" />
            <path d={`M ${hx} ${y} L ${spine + out * 2} ${y}`} stroke="#2a1407" strokeWidth={8} strokeLinecap="round" fill="none" />
            <path d={`M ${hx} ${y} L ${spine + out * 2} ${y}`} stroke={`url(#${id})`} strokeWidth={6.4} strokeLinecap="round" fill="none" />
            {across !== undefined ? (
              <>
                {/* Across the gap to the facing leaf, sagging a little, tied in the middle. */}
                <path d={`M ${spine} ${y} Q ${mid} ${y + 3} ${spine + gap + 9} ${y}`} stroke="#2a1407" strokeWidth={8} fill="none" />
                <path d={`M ${spine} ${y} Q ${mid} ${y + 3} ${spine + gap + 9} ${y}`} stroke={`url(#${id})`} strokeWidth={6.4} fill="none" />
                {/* Two tapering tails, then the knot over them. */}
                <path d={`M ${mid - 2.6} ${y + 4} C ${mid - 3.5} ${y + 10} ${mid - 7} ${y + 15} ${mid - 8.5} ${y + 20} L ${mid - 6.4} ${y + 20.6} C ${mid - 4.6} ${y + 15.5} ${mid - 1.6} ${y + 10.5} ${mid + 0.6} ${y + 4.6} Z`} fill="#6a3a1b" stroke="#2a1407" strokeWidth={0.8} />
                <path d={`M ${mid + 0.4} ${y + 4.6} C ${mid + 2.4} ${y + 10} ${mid + 5.6} ${y + 13.5} ${mid + 8.6} ${y + 17.5} L ${mid + 10.4} ${y + 16.4} C ${mid + 7.8} ${y + 12.4} ${mid + 5} ${y + 8.6} ${mid + 3.2} ${y + 3.8} Z`} fill="#83502a" stroke="#2a1407" strokeWidth={0.8} />
                <ellipse cx={mid} cy={y + 1.6} rx={6.2} ry={6.4} fill="#6a3a1b" stroke="#2a1407" strokeWidth={1} />
                <path d={`M ${mid - 5} ${y - 1.6} Q ${mid} ${y + 3.4} ${mid + 5.2} ${y + 4.4}`} stroke="#3a1c0a" strokeWidth={1.3} fill="none" />
                <path d={`M ${mid - 4.2} ${y + 5.4} Q ${mid + 0.6} ${y + 1} ${mid + 4.6} ${y - 2.4}`} stroke="#3a1c0a" strokeWidth={1.1} fill="none" opacity={0.8} />
                <ellipse cx={mid - 2} cy={y - 1.6} rx={2.4} ry={1.6} fill="#c08850" opacity={0.55} />
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Nine candidate sherds for the heap: fresh page ids, each its own pot. */
function freshHeap(): string[] {
  return Array.from({ length: 9 }, () => crypto.randomUUID());
}

/** The rubbish heap a new sherd is picked out of: a scatter of blank pieces, each a different
 *  pot, lying at odd angles. Hover lifts one; clicking picks it up as the next page. */
function SherdHeap({ ids, onPick, onRummage, onClose }: { ids: string[]; onPick(id: string): void; onRummage(): void; onClose(): void }) {
  const [pics, setPics] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    setPics({});
    ids.forEach((id) =>
      void sherdPicture(id, 200).then((url) => {
        if (live && url) setPics((p) => ({ ...p, [id]: url }));
      }),
    );
    return () => {
      live = false;
    };
  }, [ids]);
  // Where each piece lies: heaped round the middle, overlapping, the first ones buried deepest.
  const spot = (i: number, id: string): [number, number, number] => {
    const h = seedOf(id);
    const a = i * 2.4 + (h % 100) / 60;
    const r = 6 + i * 3.4 + (h % 7);
    return [50 + Math.cos(a) * r * 1.35, 52 + Math.sin(a) * r, ids.length - i];
  };
  return (
    <div className="nb-heap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="nb-heap-card">
        <div className="nb-heap-head">
          <span>Pick a sherd off the heap</span>
          <span className="nb-heap-actions">
            <button onClick={onRummage}>Rummage again</button>
            <button onClick={onClose}>Cancel</button>
          </span>
        </div>
        <div className="nb-heap-pile">
          {ids.map((id, i) => {
            const shape = sherdShape(id);
            const turn = ((seedOf(id) % 70) - 35) | 0;
            const [x, y, z] = spot(i, id);
            return (
              <button
                key={id}
                className="nb-heap-piece"
                aria-label={`Pick up the ${SHERD_FABRICS[shape.variant].toLowerCase()} sherd`}
                title={SHERD_FABRICS[shape.variant]}
                style={{ left: `${x}%`, top: `${y}%`, zIndex: z, ["--turn" as string]: `${turn}deg`, width: shape.page.width * 0.52 }}
                onClick={() => onPick(id)}
              >
                {pics[id] ? <img src={pics[id]} alt="" draggable={false} /> : null}
              </button>
            );
          })}
        </div>
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
  { host, notebookId, mode: requestedMode, zoom, onZoom, tool, penTool, mediumTool, mediumSize, rulers, revision, onState, onActivePage, onFormatState, onInkState, onExitDrawing },
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
  // A page turn in progress: the pages of the spread being left, pinned where they were.
  const [turn, setTurn] = useState<{ dir: 1 | -1; leaving: { id: string; index: number; left: number; top: number; flip: boolean }[] } | null>(null);
  const turnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipe = useRef<{ id: number; x: number; y: number; t: number } | null>(null);
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
  const medium: NotebookMedium = doc?.notebook.medium ?? "paper";
  // Only a book pages two-up; clay tablets always scroll, and sherds lie in a grid on a table
  // (a scrolling list that wraps).
  const grid = MEDIUMS[medium].flow === "grid";
  const mode = MEDIUMS[medium].flow === "book" ? requestedMode : "scroll";
  // The heap a new sherd is picked from: candidate page ids (a sherd's shape comes from its id).
  const [heap, setHeap] = useState<string[] | null>(null);
  const spec = MEDIUMS[medium];
  const base = spec.page;
  const geomOf = (p: NotebookPage | null | undefined) => (p ? pageGeometry(medium, p.id) : base);
  // Pages being smoothed flat, and a remount count for pages the core cleared (a surface loads
  // its marks once, so a smoothed page needs a fresh one).
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [epochs, setEpochs] = useState<Record<string, number>>({});

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
    if (stage.w < PHONE_W) return stage.w / (base.width - base.marginX * 2 + 32);
    // About three sherds across the table.
    if (grid) return Math.max(0.3, Math.min(1, (stage.w - STAGE_PAD * 2 - PAGE_GAP * 3) / (base.width * 2.7)));
    const chrome = STAGE_PAD * 2 + (rulers ? RULER : 0) + (across - 1) * PAGE_GAP;
    const byWidth = (stage.w - chrome) / (base.width * across);
    // A spread shows whole pages; a scrolling list only fits the width.
    const byHeight = mode === "spread" ? (stage.h - STAGE_PAD * 2 - (rulers ? RULER : 0)) / base.height : Infinity;
    // Tablets, leaves and sherds are hand-sized objects: fit never blows them up past 125%.
    return Math.max(0.25, Math.min(byWidth, byHeight, spec.grows ? 2 : 1.25));
  }, [stage, rulers, across, mode, base, spec, grid]);
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

  /** Turn the page: in a spread the leaving pages stay put and flip away (the outer one of the
   *  pair hinges on the spine; its partner fades) while the new spread comes in beneath. */
  const startTurn = useCallback(
    (dir: 1 | -1) => {
      const flow = stageRef.current?.querySelector<HTMLElement>(".nb-flow");
      if (!flow) return;
      const leaving: { id: string; index: number; left: number; top: number; flip: boolean }[] = [];
      visible.forEach((p, i) => {
        const slot = flow.querySelector<HTMLElement>(`[data-sheet="${p.id}"] .nb-slot`);
        if (!slot) return;
        const flip = dir === 1 ? i === visible.length - 1 : i === 0;
        leaving.push({ id: p.id, index: visibleOffset + i, left: slot.offsetLeft, top: slot.offsetTop, flip });
      });
      if (turnTimer.current) clearTimeout(turnTimer.current);
      setTurn({ dir, leaving });
      turnTimer.current = setTimeout(() => setTurn(null), TURN_MS);
    },
    [visible, visibleOffset],
  );
  useEffect(() => () => {
    if (turnTimer.current) clearTimeout(turnTimer.current);
  }, []);

  const goTo = useCallback(
    (page: number) => {
      const i = Math.max(0, Math.min(page, pages.length - 1));
      if (mode === "spread") {
        const nextStart = i - (i % 2);
        if (nextStart !== spreadStart) startTurn(nextStart > spreadStart ? 1 : -1);
      }
      setCurrent(i);
      if (pages[i]) setActiveId(pages[i].id);
      if (mode === "scroll") {
        // The list turns by scrolling to the page, smoothly.
        const el = stageRef.current?.querySelector<HTMLElement>(`[data-page="${i}"]`);
        // Smooth scrolling never progresses in a hidden page (no animation frames), so a
        // background tab jumps instead; the folio would otherwise report a page not on screen.
        if (el) stageRef.current?.scrollTo({ top: el.offsetTop - (STAGE_PAD / 2 + (rulers ? RULER : 0)), behavior: document.hidden ? "auto" : "smooth" });
      }
    },
    [pages, mode, rulers, spreadStart, startTurn],
  );

  // Arrow and Page keys turn pages when the keyboard isn't in a text field. Only a visible
  // view answers (background tabs keep their editors mounted).
  useEffect(() => {
    const step = mode === "spread" ? 2 : 1;
    const onKey = (e: KeyboardEvent) => {
      if (stageRef.current?.offsetParent === null) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        goTo((mode === "spread" ? spreadStart : current) + step);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goTo((mode === "spread" ? spreadStart : current) - step);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, mode, spreadStart, current]);

  // A single finger swiped sideways turns the page, on any touch screen, unless a drawing
  // tool is active (fingers then draw or pan) or the page is zoomed in (a sideways drag then
  // pans the sheet). At fit zoom the stage gives up horizontal panning so the swipe is clean.
  const swipeOn = !tool && zoom === "fit";
  const onSwipeDown = (e: ReactPointerEvent) => {
    if (!swipeOn || e.pointerType !== "touch") return;
    swipe.current = e.isPrimary && !swipe.current ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() } : null;
  };
  const onSwipeEnd = (e: ReactPointerEvent) => {
    const s = swipe.current;
    if (!s || e.pointerId !== s.id) return;
    swipe.current = null;
    if (e.type === "pointercancel") return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Date.now() - s.t > SWIPE_MAX_MS || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    const step = mode === "spread" ? 2 : 1;
    goTo((mode === "spread" ? spreadStart : current) + (dx < 0 ? step : -step));
  };

  const addPage = useCallback(async (id?: string) => {
    const after = activePage ?? pages[pages.length - 1] ?? null;
    if (!spec.addLabel) return;
    // A sherd is chosen from a heap first; the one picked comes back here with its id.
    if (grid && !id) {
      setHeap(freshHeap());
      return;
    }
    setHeap(null);
    // A new page takes the paper of the page you are on.
    const made = await host.addPage(notebookId, after?.id ?? null, spec.paper ?? after?.paper ?? { kind: "lined", spacing: 28 }, id);
    const d = await reload();
    const i = d.pages.findIndex((p) => p.id === made.id);
    setActiveId(made.id);
    setCurrent(i);
    if (mode === "scroll") requestAnimationFrame(() => stageRef.current?.querySelector<HTMLElement>(`[data-page="${i}"]`)?.scrollIntoView({ block: "start" }));
  }, [activePage, pages, host, notebookId, reload, mode, spec, grid]);

  /** Smooth the current page flat (wax: the flat of the stylus; clay: kneading). */
  const smoothPage = useCallback(async () => {
    const p = activePage;
    if (!p || busy[p.id]) return;
    setBusy((b) => ({ ...b, [p.id]: true }));
    try {
      await Promise.all([host.smoothPage(p.id), new Promise((r) => setTimeout(r, SMOOTH_MS / 2))]);
      setEpochs((e) => ({ ...e, [p.id]: (e[p.id] ?? 0) + 1 }));
      await Promise.all([reload(), new Promise((r) => setTimeout(r, SMOOTH_MS / 2))]);
    } catch (e) {
      console.error("notebook smoothing failed", e);
    } finally {
      setBusy(({ [p.id]: _, ...rest }) => rest);
    }
  }, [activePage, busy, host, reload]);

  useImperativeHandle(
    ref,
    () => ({
      goTo,
      addPage: () => void addPage(),
      smoothPage: () => void smoothPage(),
      editor: () => (activePage ? (editors.current.get(activePage.id) ?? null) : null),
    }),
    [goTo, addPage, smoothPage, activePage],
  );

  // Undo, redo and Escape while drawing go to the current page only. Each ink layer would
  // otherwise answer the same key (a spread has two on screen), so they are told not to listen.
  // Clay, wax and sherds have no text to type into, so their undo keys always work.
  useEffect(() => {
    if (!tool && medium === "paper") return;
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
  }, [tool, activePage, onExitDrawing, medium]);

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
      const size = axis === "x" ? geomOf(activePage).width : (activePage && heights.current.get(activePage.id)) || geomOf(activePage).height;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [origin, scale, guides, saveGuides, activePage, medium],
  );

  return (
    <div className={rulers ? "nb-root nb-rulers" : "nb-root"}>
      <div ref={stageRef} className="nb-stage" onScroll={onScroll} data-swipe={swipeOn} onPointerDown={onSwipeDown} onPointerUp={onSwipeEnd} onPointerCancel={onSwipeEnd}>
        <div className="nb-flow" data-mode={grid ? "grid" : mode}>
          {visible.map((page, i) => {
            const index = visibleOffset + i;
            const mounted = mode === "spread" || near.has(index);
            if (!mounted) {
              const g = geomOf(page);
              const h = heights.current.get(page.id) ?? g.height;
              return <div key={page.id} className="nb-slot nb-ghost" data-page={index} style={{ width: g.width * scale, height: h * scale }} />;
            }
            return (
              <div key={page.id} data-sheet={page.id} style={{ display: "contents" }}>
                <Sheet
                  key={epochs[page.id] ?? 0}
                  host={host}
                  medium={medium}
                  page={page}
                  index={index}
                  busy={!!busy[page.id]}
                  mediumTool={mediumTool}
                  mediumSize={mediumSize}
                  bindAcross={medium === "wax" && mode === "spread" && i === 0 && visible.length === 2 && !turn ? PAGE_GAP / scale : undefined}
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
                  entering={!!turn && mode === "spread"}
                />
              </div>
            );
          })}
          {turn && mode === "spread"
            ? turn.leaving
                .filter((l) => !visible.some((p) => p.id === l.id))
                .map((l) => {
                  const page = pages.find((p) => p.id === l.id);
                  if (!page) return null;
                  // Same key as before the turn, so the sheet (and its editor) is moved, not remade.
                  return (
                    <div key={page.id} data-sheet={page.id} style={{ display: "contents" }}>
                      <Sheet
                        key={epochs[page.id] ?? 0}
                        host={host}
                        medium={medium}
                        page={page}
                        index={l.index}
                        scale={scale}
                        tool={null}
                        penTool={null}
                        mediumTool={null}
                        active={false}
                        guides={guides}
                        showGuides={rulers}
                        onActivate={() => {}}
                        onEditor={(ctrl) => {
                          if (ctrl) editors.current.set(page.id, ctrl);
                          else editors.current.delete(page.id);
                        }}
                        onFormatState={() => {}}
                        onInkState={() => {}}
                        onExitDrawing={() => {}}
                        onPinch={() => {}}
                        onGuideDrag={() => {}}
                        onHeight={() => {}}
                        leaving={{ left: l.left, top: l.top, turn: l.flip ? (turn.dir === 1 ? "flip-next" : "flip-prev") : "fade" }}
                      />
                    </div>
                  );
                })
            : null}
          {doc && mode === "spread" && visible.length === 1 && spec.addLabel ? (
            <button className="nb-slot nb-blank" style={{ width: base.width * scale, height: base.height * scale }} onClick={() => void addPage()}>
              {spec.addLabel.replace(/ after this one$/, "")}
            </button>
          ) : null}
        </div>
      </div>
      {heap ? <SherdHeap ids={heap} onPick={(id) => void addPage(id)} onRummage={() => setHeap(freshHeap())} onClose={() => setHeap(null)} /> : null}
      {rulers ? (
        <>
          <div className="nb-ruler nb-ruler-x" onPointerDown={(e) => dragGuide("y", null, e)}>
            <RulerTicks axis="x" origin={origin.x - RULER} length={Math.max(0, stage.w - RULER)} scale={scale} pageSize={geomOf(activePage).width} />
          </div>
          <div className="nb-ruler nb-ruler-y" onPointerDown={(e) => dragGuide("x", null, e)}>
            <RulerTicks
              axis="y"
              origin={origin.y - RULER}
              length={Math.max(0, stage.h - RULER)}
              scale={scale}
              pageSize={(activePage && heights.current.get(activePage.id)) || geomOf(activePage).height}
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
