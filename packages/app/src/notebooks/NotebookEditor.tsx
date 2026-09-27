import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { Button, Divider, Icon, IconButton, Text, colors, layout, radius, row, shadow, space, useDensity } from "@companion/design-system";
import type { IconName, PressState } from "@companion/design-system";
import type { EditorController, FormatState, InkState } from "@companion/editor";
import { FormattingBar } from "../FormattingBar";
import { DrawingBar, useDrawingTool } from "../DrawingBar";
import { ConfirmDialog } from "../ConfirmDialog";
import { useCore } from "../CoreContext";
import type { NotebookHost, NotebookPage, NotebookViewMode } from "./host";
import { NotebookView, type NotebookViewController, type NotebookViewState, type NotebookZoom } from "./NotebookView";
import { PAPER_KINDS, PAPER_SPACINGS, SPACING_LABEL, type PaperStyle } from "./paper";
import { CoverDialog } from "./CoverDialog";
import { MEDIUMS, MEDIUM_SIZES, mediumOf, type MediumSize, type MediumTool, type MediumToolId } from "./mediums";
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
  const spec = MEDIUMS[medium];
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

  // Jump to the requested page once the pages are known.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !initialPage || state.pageCount === 0) return;
    jumped.current = true;
    viewRef.current?.goTo(initialPage - 1);
  }, [initialPage, state.pageCount]);

  editorRef.current = viewRef.current?.editor() ?? null;
  const syncEditor = useCallback((p: NotebookPage | null) => {
    setPage(p);
    queueMicrotask(() => {
      editorRef.current = viewRef.current?.editor() ?? null;
    });
  }, []);

  // Only a book pages two-up (clay scrolls, sherds lie in a grid), so the rest step singly.
  const paged = spec.flow === "book";
  const step = mode === "spread" && paged ? 2 : 1;
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
    await host.deletePage(page.id);
    setConfirm(null);
    setRevision((r) => r + 1);
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
        { value: "spread", label: "Two pages", icon: "panelLeft" },
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
};
