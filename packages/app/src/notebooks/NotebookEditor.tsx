import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { Button, Divider, Icon, IconButton, Text, colors, font, layout, radius, row, shadow, space, useDensity } from "@companion/design-system";
import type { IconName, PressState } from "@companion/design-system";
import type { EditorController, FormatState, InkState } from "@companion/editor";
import { FormattingBar } from "../FormattingBar";
import { DrawingBar, useDrawingTool } from "../DrawingBar";
import { ConfirmDialog } from "../ConfirmDialog";
import { Dialog } from "../Dialog";
import { useCore } from "../CoreContext";
import type { NotebookHost, NotebookPage, NotebookViewMode } from "./host";
import { NotebookView, type NotebookViewController, type NotebookViewState, type NotebookZoom } from "./NotebookView";
import { PAPER_KINDS, PAPER_SPACINGS, SPACING_LABEL, type PaperStyle } from "./paper";
import { CoverDialog } from "./CoverDialog";
import { MEDIUM_SIZES, mediumOf, specFor, type MediumSize, type MediumTool, type MediumToolId } from "./mediums";
import { BINDINGS, bindingOf, type Booklet } from "./bindings";
import { useNotebooks } from "./NotebooksProvider";

// The notebook editor (PLAN-notebooks.md §1): full width, a back button to the shelf, the
// pages two-up or in a scrolling list, and a bottom toolbar for typing, inking, pages, zoom
// and view. The notebook's medium (PLAN §11) decides which page actions exist and what
// they're called. Clay, wax and sherds are pen-only: they swap the formatting and drawing bars
// for their own tools (stylus and wedge, point and flat end, brush and scraper), and on a touch
// screen the mode switch says whether a finger scrolls or draws. Plain React Native around the
// DOM page view, so the same chrome serves web, desktop and (over the WebView bundle) the
// native app.

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** The size each pen tool was last used at, for the session. */
const toolSizes: Partial<Record<MediumToolId, MediumSize>> = {};

export interface NotebookEditorProps {
  host: NotebookHost;
  notebookId: string;
  onBack(): void;
  /** Render the top bar (back, title, view toggle). A mobile shell hosts those in its nav bar
   *  and turns this off. */
  showTopBar?: boolean;
  /** Open on this page (1-based), e.g. from a search hit. */
  initialPage?: number;
}

export function NotebookEditor({ host, notebookId, onBack, showTopBar = true, initialPage }: NotebookEditorProps) {
  const { core } = useCore();
  const notebooks = useNotebooks();
  const notebook = notebooks.byId(notebookId);
  const medium = mediumOf(notebook?.settingsJson);
  const binding = bindingOf(notebook?.settingsJson);
  const spec = specFor(medium, binding);
  const bound = binding ? BINDINGS[binding] : null;
  const { width } = useWindowDimensions();
  const touch = useDensity() === "touch";
  const narrow = width < 900;
  const viewRef = useRef<NotebookViewController>(null);
  // The formatting bar drives "the current page" through one stable ref.
  const editorRef = useRef<EditorController | null>(null);
  const [mode, setMode] = useState<NotebookViewMode>(narrow ? "scroll" : "spread");
  const [zoom, setZoom] = useState<NotebookZoom>("fit");
  const [rulers, setRulers] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [tool, setTool] = useDrawingTool();
  const [state, setState] = useState<NotebookViewState>({ page: 0, pageCount: 0, scale: 1 });
  const [page, setPage] = useState<NotebookPage | null>(null);
  const [formatState, setFormatState] = useState<FormatState | null>(null);
  const [inkState, setInkState] = useState<InkState | null>(null);
  const [paperOpen, setPaperOpen] = useState(false);
  const [cover, setCover] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "smooth" | null>(null);
  // A traveler's notebook: the booklet open in the cover, and one being renamed.
  const booklets = binding === "travelers" ? (notebook?.settingsJson?.booklets ?? []) : [];
  const inCover = booklets.filter((b) => !b.archived);
  const [bookletId, setBookletId] = useState<string | null>(null);
  const booklet = inCover.find((b) => b.id === bookletId) ?? inCover[0] ?? null;
  const [renaming, setRenaming] = useState<Booklet | null>(null);
  const [shelved, setShelved] = useState(false);
  // A ring binder: the binder a page is being moved to.
  const [moving, setMoving] = useState(false);
  // What the core refused (a booklet's last page, a full stapled notebook), for a moment.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message.replace(/^[a-z]/, (c) => c.toUpperCase()) : "That didn't work.");
    }
    setRevision((r) => r + 1);
  };
  const [mediumTool, setMediumTool] = useState<MediumToolId | null>(spec.tools[0]?.id ?? null);
  const [sizes, setSizes] = useState(toolSizes);
  const mediumSize: MediumSize = (mediumTool && sizes[mediumTool]) ?? 1;
  const setMediumSize = (size: MediumSize) => {
    if (!mediumTool) return;
    toolSizes[mediumTool] = size;
    setSizes({ ...toolSizes });
  };
  const penOnly = medium !== "paper";

  // The notebook (and so its medium) can arrive after the first render.
  useEffect(() => {
    if (!spec.tools.some((t) => t.id === mediumTool)) setMediumTool(spec.tools[0]?.id ?? null);
  }, [spec, mediumTool]);
  const [revision, setRevision] = useState(0);

  // A phone has no room for a spread.
  useEffect(() => {
    if (narrow && mode === "spread") setMode("scroll");
  }, [narrow, mode]);

  // Pages or ink pulled by a sync, or changed by another surface: re-read the notebook.
  useEffect(() => {
    const bump = (payload: unknown) => {
      const id = (payload as { notebookId?: string } | undefined)?.notebookId;
      if (!id || id === notebookId) setRevision((r) => r + 1);
    };
    const offBooks = core.on("notebooks.changed", bump);
    const offData = core.on("data.changed", () => setRevision((r) => r + 1));
    return () => {
      offBooks();
      offData();
    };
  }, [core, notebookId]);

  // Jump to the requested page once the pages are known; a sewn journal opens at its ribbon.
  const jumped = useRef(false);
  const ribbon = typeof notebook?.settingsJson?.ribbon === "string" ? (notebook.settingsJson.ribbon as string) : null;
  useEffect(() => {
    if (jumped.current || state.pageCount === 0) return;
    jumped.current = true;
    if (initialPage) viewRef.current?.goTo(initialPage - 1);
    else if (ribbon && binding === "sewn") {
      void host.load(notebookId).then((d) => {
        const i = d.pages.findIndex((p) => p.id === ribbon);
        if (i > 0) viewRef.current?.goTo(i);
      });
    }
  }, [initialPage, state.pageCount, ribbon, binding, host, notebookId]);

  editorRef.current = viewRef.current?.editor() ?? null;
  const syncEditor = useCallback((p: NotebookPage | null) => {
    setPage(p);
    queueMicrotask(() => {
      editorRef.current = viewRef.current?.editor() ?? null;
    });
  }, []);

  // A book pages two-up and a pad one page at a time (clay scrolls, sherds and cards lie in a
  // grid, a concertina unfolds), so the rest step singly.
  const paged = spec.flow === "book" || spec.flow === "pad" || spec.flow === "pad-top";
  const step = mode === "spread" && spec.flow === "book" ? 2 : 1;
  const stepZoom = (dir: 1 | -1) => {
    const at = state.scale;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > at + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < at - 0.01);
    if (next) setZoom(next);
  };
  const setPaper = async (patch: Partial<PaperStyle>) => {
    if (!page) return;
    await host.setPaper(page.id, { ...page.paper, ...patch });
    setRevision((r) => r + 1);
  };
  const deletePage = async () => {
    if (!page) return;
    setConfirm(null);
    await attempt(async () => {
      // A concertina is only ever cut at its end.
      const target = binding === "accordion" ? (await host.load(notebookId)).pages.at(-1)?.id : page.id;
      if (target) await host.deletePage(target);
    });
  };
  const last = Math.max(0, state.pageCount - 1);
  const folio = step === 2 && state.page + 1 <= last ? `${state.page + 1}–${state.page + 2}` : `${state.page + 1}`;
  const glyph = touch ? 17 : 13;
  const btn = touch ? ("lg" as const) : ("sm" as const);

  const pageControls = (
    <>
      <IconButton label="Previous page" size={btn} disabled={state.page <= 0} onPress={() => viewRef.current?.goTo(state.page - step)}>
        <Icon name="chevronLeft" size={glyph} color={colors.textSecondary} />
      </IconButton>
      <Text variant="mono" tone="secondary" style={{ minWidth: 64, textAlign: "center" }}>
        {folio} / {state.pageCount}
      </Text>
      <IconButton label="Next page" size={btn} disabled={state.page + step > last} onPress={() => viewRef.current?.goTo(state.page + step)}>
        <Icon name="chevronRight" size={glyph} color={colors.textSecondary} />
      </IconButton>
      {spec.addLabel ? (
        <IconButton label={spec.addLabel} size={btn} onPress={() => viewRef.current?.addPage()}>
          <Icon name="plus" size={glyph} color={colors.textSecondary} />
        </IconButton>
      ) : null}
      {spec.deleteLabel ? (
        <IconButton label={spec.deleteLabel} size={btn} disabled={state.pageCount <= 1} onPress={() => setConfirm("delete")}>
          <Icon name="trash" size={glyph} color={colors.textSecondary} />
        </IconButton>
      ) : null}
      {bound?.reorder ? (
        <>
          <IconButton label={`Move this ${bound.noun} earlier`} size={btn} disabled={!page} onPress={() => viewRef.current?.movePageBy(-1)}>
            <Text tone="secondary">←</Text>
          </IconButton>
          <IconButton label={`Move this ${bound.noun} later`} size={btn} disabled={!page} onPress={() => viewRef.current?.movePageBy(1)}>
            <Text tone="secondary">→</Text>
          </IconButton>
        </>
      ) : null}
      {binding === "cards" ? (
        <IconButton label="Shuffle the box" size={btn} disabled={state.pageCount < 2} onPress={() => viewRef.current?.shuffle()}>
          <Icon name="repeat" size={glyph} color={colors.textSecondary} />
        </IconButton>
      ) : null}
      {bound?.move ? (
        <IconButton label="Move this page to another binder" size={btn} disabled={!page || state.pageCount <= 1} onPress={() => setMoving(true)}>
          <Icon name="folder" size={glyph} color={colors.textSecondary} />
        </IconButton>
      ) : null}
      {binding === "sewn" ? (
        <IconButton label={page && page.id === ribbon ? "The ribbon is in this page" : "Lay the ribbon in this page"} size={btn} active={!!page && page.id === ribbon} disabled={!page} onPress={() => page && void attempt(() => host.setRibbon(notebookId, page.id))}>
          <Icon name="tag" size={glyph} color={page && page.id === ribbon ? colors.textAccent : colors.textSecondary} />
        </IconButton>
      ) : null}
    </>
  );
  const zoomControls = (
    <>
      <IconButton label="Zoom out" size={btn} onPress={() => stepZoom(-1)}>
        <Text tone="secondary">−</Text>
      </IconButton>
      <Pressable aria-label="Zoom to fit" onPress={() => setZoom("fit")} style={styles.zoomLabel}>
        <Text variant="mono" tone={zoom === "fit" ? "accent" : "secondary"}>
          {Math.round(state.scale * 100)}%
        </Text>
      </Pressable>
      <IconButton label="Zoom in" size={btn} onPress={() => stepZoom(1)}>
        <Text tone="secondary">+</Text>
      </IconButton>
    </>
  );
  const mediumControls =
    medium === "paper" ? (
      <IconButton label="Paper" size={btn} active={paperOpen} onPress={() => setPaperOpen((v) => !v)}>
        <Icon name="file" size={glyph} color={paperOpen ? colors.textAccent : colors.textSecondary} />
      </IconButton>
    ) : spec.smooth ? (
      <IconButton label={spec.smooth.label} size={btn} disabled={!page} onPress={() => setConfirm("smooth")}>
        <Icon name="waves" size={glyph} color={colors.textSecondary} />
      </IconButton>
    ) : null;
  const viewControls = (
    <>
      {mediumControls}
      <IconButton label={rulers ? "Hide rulers and guides" : "Show rulers and guides"} size={btn} active={rulers} onPress={() => setRulers((v) => !v)}>
        <Icon name="grip" size={glyph} color={rulers ? colors.textAccent : colors.textSecondary} />
      </IconButton>
    </>
  );
  const modeToggle = !narrow && paged ? (
    <Segmented
      value={mode}
      onChange={(m) => setMode(m)}
      options={[
        { value: "spread", label: spec.flow === "book" ? "Two pages" : "One page", icon: "panelLeft" },
        { value: "scroll", label: "Scroll", icon: "listBullet" },
      ]}
    />
  ) : null;
  // Pen-only mediums have nothing to type; on a touch screen the switch says what a finger does.
  const typeDraw = !penOnly ? (
    <Segmented
      value={drawing ? "draw" : "type"}
      onChange={(v) => setDrawing(v === "draw")}
      options={[
        { value: "type", label: "Type", icon: "bold" },
        { value: "draw", label: "Draw", icon: "pen" },
      ]}
    />
  ) : touch ? (
    <Segmented
      value={drawing ? "draw" : "scroll"}
      onChange={(v) => setDrawing(v === "draw")}
      options={[
        { value: "scroll", label: "Scroll", icon: "listBullet" },
        { value: "draw", label: "Finger draws", icon: "pen" },
      ]}
    />
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceApp }}>
      {showTopBar ? (
        <View style={styles.topBar}>
          <Button variant="ghost" size="sm" icon={<Icon name="chevronLeft" size={13} color={colors.textSecondary} />} label="Notebooks" onPress={onBack} />
          <Divider vertical style={styles.divider} />
          <Pressable aria-label="Edit notebook title and cover" onPress={() => setCover(true)} style={{ flexShrink: 1 }}>
            <Text variant="title" numberOfLines={1}>
              {notebook?.title || "Untitled"}
            </Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {modeToggle}
        </View>
      ) : null}

      {binding === "travelers" ? (
        <BookletBar
          booklets={booklets}
          current={booklet}
          onOpen={(b) => setBookletId(b.id)}
          onAdd={() =>
            void attempt(async () => {
              const b = await host.addBooklet(notebookId, "", page?.paper ?? { kind: "lined", spacing: 28 });
              setBookletId(b.id);
            })
          }
          onRename={setRenaming}
          onSlipOut={(b) => void attempt(() => host.updateBooklet(notebookId, b.id, { archived: true }))}
          shelved={shelved}
          onShelved={setShelved}
          onPutBack={(b) =>
            void attempt(async () => {
              await host.updateBooklet(notebookId, b.id, { archived: false });
              setBookletId(b.id);
              setShelved(false);
            })
          }
        />
      ) : null}
      <View style={{ flex: 1, minHeight: 0 }}>
        <NotebookView
          ref={viewRef}
          host={host}
          notebookId={notebookId}
          mode={mode}
          zoom={zoom}
          onZoom={setZoom}
          tool={drawing ? tool : null}
          penTool={tool}
          mediumTool={mediumTool}
          mediumSize={MEDIUM_SIZES[mediumSize].scale}
          rulers={rulers}
          booklet={booklet?.id ?? null}
          revision={revision}
          onState={setState}
          onActivePage={syncEditor}
          onFormatState={setFormatState}
          onInkState={setInkState}
          onExitDrawing={() => setDrawing(false)}
        />
        {paperOpen && page ? (
          <View style={styles.popover}>
            <Text variant="eyebrow" tone="tertiary">
              Paper · page {state.page + 1}
            </Text>
            <View style={styles.popoverRow}>
              {PAPER_KINDS.map((k) => (
                <Chip key={k.kind} label={k.label} active={page.paper.kind === k.kind} onPress={() => void setPaper({ kind: k.kind })} />
              ))}
            </View>
            {page.paper.kind !== "blank" ? (
              <View style={styles.popoverRow}>
                {PAPER_SPACINGS.map((s) => (
                  <Chip key={s} label={SPACING_LABEL[s]} active={page.paper.spacing === s} onPress={() => void setPaper({ spacing: s })} />
                ))}
              </View>
            ) : null}
            <Text tone="tertiary" variant="caption">
              New pages take the paper of the page you are on.
            </Text>
          </View>
        ) : null}
        {notice ? (
          <Pressable style={styles.notice} onPress={() => setNotice(null)}>
            <Text tone="secondary">{notice}</Text>
          </Pressable>
        ) : null}
      </View>

      {/* The typing or drawing tools for the current page, then pages, zoom and view. */}
      {penOnly ? (
        <MediumBar
          tools={spec.tools}
          value={mediumTool}
          onChange={setMediumTool}
          size={mediumSize}
          onSize={setMediumSize}
          state={inkState}
          onUndo={() => viewRef.current?.editor()?.inkUndo()}
          onRedo={() => viewRef.current?.editor()?.inkRedo()}
        />
      ) : drawing ? (
        <DrawingBar tool={tool} onChange={setTool} state={inkState} onUndo={() => viewRef.current?.editor()?.inkUndo()} onRedo={() => viewRef.current?.editor()?.inkRedo()} onDone={() => setDrawing(false)} />
      ) : (
        <FormattingBar state={formatState} editorRef={editorRef} canAttach={false} />
      )}
      {touch ? (
        // A phone: one scrolling row, the mode switch pinned at its start.
        <View style={[styles.bottomBar, styles.bottomBarTouch]}>
          {typeDraw}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.touchContent} style={{ flex: 1 }}>
            {pageControls}
            <Divider vertical style={styles.divider} />
            {zoomControls}
            <Divider vertical style={styles.divider} />
            {viewControls}
          </ScrollView>
        </View>
      ) : (
        <View style={styles.bottomBar}>
          {typeDraw}
          <View style={{ flex: 1 }} />
          {pageControls}
          <View style={{ flex: 1 }} />
          {zoomControls}
          <Divider vertical style={styles.divider} />
          {viewControls}
        </View>
      )}

      {cover ? <CoverDialog notebookId={notebookId} onClose={() => setCover(false)} /> : null}
      {confirm === "delete" && spec.deleteConfirm ? (
        <ConfirmDialog
          title={spec.deleteConfirm.title}
          message={spec.deleteConfirm.message}
          confirmLabel={spec.deleteLabel?.replace(/ this .*$/, "") ?? "Delete"}
          onConfirm={() => void deletePage()}
          onClose={() => setConfirm(null)}
        />
      ) : null}
      {moving && page ? (
        <MoveToBinder
          notebookId={notebookId}
          onClose={() => setMoving(false)}
          onPick={(to) => {
            setMoving(false);
            void attempt(() => host.movePage(page.id, to));
          }}
        />
      ) : null}
      {renaming ? (
        <RenameBooklet
          booklet={renaming}
          onClose={() => setRenaming(null)}
          onSave={(title) => {
            setRenaming(null);
            void attempt(() => host.updateBooklet(notebookId, renaming.id, { title }));
          }}
        />
      ) : null}
      {confirm === "smooth" && spec.smooth ? (
        <ConfirmDialog
          title={spec.smooth.title}
          message={spec.smooth.message}
          confirmLabel={spec.smooth.confirm}
          onConfirm={() => {
            setConfirm(null);
            viewRef.current?.smoothPage();
          }}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </View>
  );
}

/** A traveler's notebook's booklets: a tab for each in the cover, a new one slipped in, and the
 *  ones slipped out kept to hand. */
function BookletBar({
  booklets,
  current,
  onOpen,
  onAdd,
  onRename,
  onSlipOut,
  shelved,
  onShelved,
  onPutBack,
}: {
  booklets: Booklet[];
  current: Booklet | null;
  onOpen(b: Booklet): void;
  onAdd(): void;
  onRename(b: Booklet): void;
  onSlipOut(b: Booklet): void;
  shelved: boolean;
  onShelved(open: boolean): void;
  onPutBack(b: Booklet): void;
}) {
  const touch = useDensity() === "touch";
  const btn = touch ? ("lg" as const) : ("sm" as const);
  const out = booklets.filter((b) => b.archived);
  const inCover = booklets.filter((b) => !b.archived);
  return (
    <View style={styles.bookletBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs, alignItems: "center" }} style={{ flexShrink: 1 }}>
        {inCover.map((b) => (
          <Chip key={b.id} label={b.title} active={b.id === current?.id} onPress={() => onOpen(b)} />
        ))}
      </ScrollView>
      <IconButton label="Slip in a new booklet" size={btn} onPress={onAdd}>
        <Icon name="plus" size={13} color={colors.textSecondary} />
      </IconButton>
      <View style={{ flex: 1 }} />
      {current ? (
        <>
          <Button variant="ghost" size="sm" label="Rename" onPress={() => onRename(current)} />
          <Button variant="ghost" size="sm" label="Slip out" disabled={inCover.length <= 1} onPress={() => onSlipOut(current)} />
        </>
      ) : null}
      {out.length ? <Button variant="ghost" size="sm" label={`Slipped out · ${out.length}`} onPress={() => onShelved(!shelved)} /> : null}
      {shelved && out.length ? (
        <View style={[styles.popover, { top: layout.toolbarH, bottom: undefined }]}>
          <Text variant="eyebrow" tone="tertiary">
            Slipped out of the cover
          </Text>
          {out.map((b) => (
            <View key={b.id} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <Text style={{ flex: 1 }} numberOfLines={1}>
                {b.title}
              </Text>
              <Button variant="ghost" size="sm" label="Put back" onPress={() => onPutBack(b)} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function RenameBooklet({ booklet, onClose, onSave }: { booklet: Booklet; onClose(): void; onSave(title: string): void }) {
  const [title, setTitle] = useState(booklet.title);
  const save = () => title.trim() && onSave(title.trim());
  return (
    <Dialog
      title="Rename booklet"
      onClose={onClose}
      width={380}
      footer={
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Button variant="ghost" size="sm" label="Cancel" onPress={onClose} />
          <Button size="sm" label="Rename" disabled={!title.trim()} onPress={save} />
        </View>
      }
    >
      <TextInput aria-label="Booklet title" autoFocus value={title} onChangeText={setTitle} onSubmitEditing={save} style={styles.input} />
    </Dialog>
  );
}

/** Pick the ring binder a page is unclipped into. */
function MoveToBinder({ notebookId, onClose, onPick }: { notebookId: string; onClose(): void; onPick(id: string): void }) {
  const notebooks = useNotebooks();
  const binders = notebooks.notebooks.filter((n) => n.id !== notebookId && bindingOf(n.settingsJson) === "ring");
  return (
    <Dialog title="Move page to another binder" onClose={onClose} width={400} footer={<Button variant="ghost" size="sm" label="Cancel" onPress={onClose} />}>
      <View style={{ gap: space.xs, paddingVertical: space.md }}>
        {binders.length === 0 ? (
          <Text tone="tertiary">There's no other ring binder to move it to. Make one from New notebook.</Text>
        ) : (
          binders.map((n) => (
            <Pressable
              key={n.id}
              aria-label={`Move to ${n.title || "Untitled"}`}
              onPress={() => onPick(n.id)}
              style={({ hovered }: PressState) => [styles.binderRow, { backgroundColor: hovered ? colors.surfaceHover : "transparent" }]}
            >
              <Icon name="notebook" size={13} color={colors.textSecondary} />
              <Text style={{ flex: 1 }} numberOfLines={1}>
                {n.title || "Untitled"}
              </Text>
              <Text variant="mono" tone="quaternary">
                {n.pageCount} {n.pageCount === 1 ? "page" : "pages"}
              </Text>
            </Pressable>
          ))
        )}
      </View>
    </Dialog>
  );
}

/** The pen tools of a clay, wax or pottery notebook, with undo and redo. */
function MediumBar({
  tools,
  value,
  onChange,
  size,
  onSize,
  state,
  onUndo,
  onRedo,
}: {
  tools: MediumTool[];
  value: MediumToolId | null;
  onChange(tool: MediumToolId): void;
  size: MediumSize;
  onSize(size: MediumSize): void;
  state: InkState | null;
  onUndo(): void;
  onRedo(): void;
}) {
  const touch = useDensity() === "touch";
  const btn = touch ? ("lg" as const) : ("sm" as const);
  return (
    <View style={styles.mediumBar}>
      {tools.map((t) => {
        const on = t.id === value;
        return (
          <Pressable
            key={t.id}
            aria-label={t.label}
            aria-selected={on}
            onPress={() => onChange(t.id)}
            style={({ hovered }: PressState) => [
              styles.toolChip,
              touch ? styles.toolChipTouch : null,
              { backgroundColor: on ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent", borderColor: on ? colors.accentSoftBorder : "transparent" },
            ]}
          >
            {t.swatch ? <View style={[styles.swatchDot, { backgroundColor: t.swatch }]} /> : <Icon name={t.icon} size={12} color={on ? colors.textAccent : colors.textSecondary} />}
            <Text tone={on ? "accent" : "secondary"}>{t.label}</Text>
          </Pressable>
        );
      })}
      <Divider vertical style={styles.divider} />
      {/* Fine, medium, broad: dots that grow, for whichever tool is in hand. */}
      {MEDIUM_SIZES.map((s) => {
        const on = s.size === size;
        const d = 4 + s.size * 3.5;
        return (
          <Pressable
            key={s.size}
            aria-label={s.label}
            aria-selected={on}
            onPress={() => onSize(s.size)}
            style={({ hovered }: PressState) => [
              styles.sizeChip,
              touch ? styles.sizeChipTouch : null,
              { backgroundColor: on ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent", borderColor: on ? colors.accentSoftBorder : "transparent" },
            ]}
          >
            <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: on ? colors.textAccent : colors.textSecondary }} />
          </Pressable>
        );
      })}
      <View style={{ flex: 1 }} />
      <IconButton label="Undo" size={btn} disabled={!state?.canUndo} onPress={onUndo}>
        <Icon name="undo" size={13} color={colors.textSecondary} />
      </IconButton>
      <IconButton label="Redo" size={btn} disabled={!state?.canRedo} onPress={onRedo}>
        <Icon name="redo" size={13} color={colors.textSecondary} />
      </IconButton>
    </View>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange(v: T): void; options: { value: T; label: string; icon: IconName }[] }) {
  const touch = useDensity() === "touch";
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            aria-label={o.label}
            aria-selected={on}
            onPress={() => onChange(o.value)}
            style={({ hovered }: PressState) => [styles.segment, touch ? styles.segmentTouch : null, { backgroundColor: on ? colors.surfaceCard : hovered ? colors.surfaceHover : "transparent" }]}
          >
            <Icon name={o.icon} size={12} color={on ? colors.textAccent : colors.textSecondary} />
            <Text tone={on ? "default" : "secondary"}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress(): void }) {
  return (
    <Pressable
      aria-selected={active}
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.chip,
        { backgroundColor: active ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent", borderColor: active ? colors.accentSoftBorder : colors.borderDefault },
      ]}
    >
      <Text tone={active ? "accent" : "secondary"}>{label}</Text>
    </Pressable>
  );
}

const styles = {
  topBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: layout.toolbarH,
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  bottomBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: layout.toolbarH,
    paddingHorizontal: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
    flexShrink: 0,
  },
  bottomBarTouch: { height: row.touch + 4, backgroundColor: colors.surfaceCard, paddingLeft: space.sm },
  touchContent: { alignItems: "center" as const, gap: space.xxs, paddingHorizontal: space.sm },
  divider: { alignSelf: "center" as const, height: 14, marginHorizontal: space.xs },
  zoomLabel: { minWidth: 44, alignItems: "center" as const },
  segmented: { flexDirection: "row" as const, padding: 2, gap: 2, borderRadius: radius.md, backgroundColor: colors.surfaceSunken },
  segment: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, height: 22, paddingHorizontal: space.md, borderRadius: radius.sm },
  segmentTouch: { height: 32, paddingHorizontal: space.ml },
  mediumBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    minHeight: layout.toolbarH,
    paddingHorizontal: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  toolChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    height: 24,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  toolChipTouch: { height: 34, paddingHorizontal: space.ml },
  sizeChip: { width: 26, height: 24, alignItems: "center" as const, justifyContent: "center" as const, borderRadius: radius.md, borderWidth: 1 },
  sizeChipTouch: { width: 36, height: 34 },
  swatchDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: "rgba(255,255,255,0.35)" },
  chip: { height: 26, paddingHorizontal: space.ml, justifyContent: "center" as const, borderRadius: radius.md, borderWidth: 1 },
  popover: {
    position: "absolute" as const,
    right: space.lg,
    bottom: space.lg,
    width: 300,
    maxWidth: "90%" as const,
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceOverlay,
    zIndex: 10,
    ...shadow.md,
  },
  popoverRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.sm },
  bookletBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: layout.toolbarH,
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
    zIndex: 11,
  },
  notice: {
    position: "absolute" as const,
    alignSelf: "center" as const,
    bottom: space.lg,
    maxWidth: "90%" as const,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceOverlay,
    zIndex: 12,
    ...shadow.md,
  },
  input: {
    fontFamily: font.sans,
    fontSize: font.size.base,
    color: colors.textPrimary,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefault,
    paddingVertical: space.sm,
    outlineStyle: "none" as never,
  },
  binderRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.md },
};
