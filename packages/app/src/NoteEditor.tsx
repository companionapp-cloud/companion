import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import type { Note } from "@companion/core-bridge";
import { Badge, Icon, IconButton, Text, colors, layout, row, space, useDensity } from "@companion/design-system";
import { Editor, type EditorController, type FormatState, type InkState, type LinkRef } from "@companion/editor";
import { FormattingBar } from "./FormattingBar";
import { DrawingBar, useDrawingTool } from "./DrawingBar";
import { useNoteInk } from "./useNoteInk";
import { tableMenuPresenter } from "./tableMenu";
import { useTasks } from "./TasksProvider";
import { useNotes } from "./NotesProvider";
import { ArchetypeChip, MetadataSidePanel, ObjectMetadataPanel } from "./ArchetypeSection";
import { useLinkSource } from "./useLinkSource";
import { useQuickCreateLink } from "./useQuickCreateLink";
import { useDocumentSource } from "./DocumentSourceContext";
import { NoteGraph } from "./NoteGraph";
import { MembershipPicker } from "./MembershipPicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { NoteConflictDialog } from "./NoteConflictDialog";
import { useNoteSyncGuard } from "./useNoteSyncGuard";
import { NavContext } from "./nav-context";
import { timeAgo } from "./NotificationRow";
import { DocTitleField } from "./TaskEditor";

export interface NoteEditorProps {
  note: Note;
  onChange: (id: string, fields: { title?: string; contentMd?: string }) => void;
  /** Shown as an "open in the workspace tab strip" action in the note's sub-toolbar when
   *  provided (used from the project detail pane, which has no tabs of its own). */
  onPopOut?: (id: string) => void;
  /** Shown as a delete action in the note's sub-toolbar when provided. */
  onDelete?: (id: string) => void;
  /** Called with the id of a note created from "save my changes as a new note" during a
   *  sync-conflict resolution, so the host can open it. */
  onCreatedNote?: (id: string) => void;
  /** Open a wikilink target the reader clicked (e.g. a `[[task:…]]` chip) — the host puts
   *  it in a new workspace tab. */
  onOpenRef?: (ref: LinkRef) => void;
  /** Render the built-in sub-toolbar (projects, graph, metadata, pop-out, delete) and the
   *  overlays it opens. Desktop keeps it; a mobile shell turns it off and hosts those actions
   *  in its nav bar instead — exactly as with `TaskEditor`: the host renders its own
   *  `MembershipPicker` / `ConfirmDialog`, swaps in `NoteGraph` for the graph, and the
   *  structured fields show inline under the title once a type is set (there is no side
   *  panel to toggle). Sync-conflict and quick-create dialogs stay in here either way. */
  showToolbar?: boolean;
  /** Drawing mode (PLAN-drawing.md), for hosts that put the pen toggle in their own chrome (the
   *  mobile nav bar). Omit both and the editor keeps its own state behind its sub-toolbar
   *  toggle. */
  drawing?: boolean;
  onDrawingChange?: (drawing: boolean) => void;
}

/** The document-style editor for a single note: a sub-toolbar of note-scoped actions,
 * the title, and a ProseMirror body (from @companion/editor). App-level chrome stays in
 * the app toolbar. Keyed by note id upstream, so each note gets a fresh instance. */
export function NoteEditor({
  note,
  onChange,
  onPopOut,
  onDelete,
  onCreatedNote,
  onOpenRef,
  showToolbar = true,
  drawing: drawingProp,
  onDrawingChange,
}: NoteEditorProps) {
  // Task metadata (for `[[task:…]]` chip hydration) also refreshes the chips; `tasks.tasks`
  // identity changes on any task edit, which we pass as linkRevision below.
  const tasks = useTasks();
  const notes = useNotes();
  // Wikilink autocomplete ([[) and pasted-UUID resolution search the object graph.
  const linkSource = useLinkSource();
  // File embedding (PLAN §6.9): present on web (OPFS blob store), undefined elsewhere.
  const documentSource = useDocumentSource();
  const [title, setTitle] = useState(note.title);
  // Seed the editor from `seed.content`; it owns its content thereafter and reports edits
  // back out. `seed.key` remounts it when the sync guard silently adopts a server version
  // (re-injecting via a changing prop is unsafe on the mobile WebView, so we remount).
  const [seed, setSeed] = useState(() => ({ key: 0, content: note.contentMd }));
  // The editor's latest reported markdown, read when saving local edits as a new note.
  const contentRef = useRef(note.contentMd);
  // Toggle between the document and this note's link graph (centered on the note).
  const [showGraph, setShowGraph] = useState(false);
  // Toggle the object metadata side panel (structured props for the note's type).
  const [showMeta, setShowMeta] = useState(false);
  // Project membership picker overlay for this note (PLAN §6.6).
  const [showProjects, setShowProjects] = useState(false);
  // Delete is irreversible, so gate it behind a confirmation.
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Touch density (the mobile shells) keeps 44px chrome, `lg` controls and a 20px inset.
  const touch = useDensity() === "touch";
  // Web/desktop: the formatting bar is pinned under the document. The editor reports which
  // toggles are active/available; the ref drives them. (On native the editor renders its
  // own keyboard-anchored toolbar, so this stays dormant.)
  const editorRef = useRef<EditorController>(null);
  // Empty `[[label]]` links: double-clicking one opens a quick-create dialog that makes a
  // note/task and swaps the raw text for a real chip.
  const quickCreate = useQuickCreateLink(editorRef);
  const [formatState, setFormatState] = useState<FormatState | null>(null);
  // Drawing over the note (PLAN-drawing.md): the note's ink, the active tool, and whether the
  // editor is in drawing mode (controlled by the host when it passes `drawing`).
  const ink = useNoteInk(note.id);
  const [drawingLocal, setDrawingLocal] = useState(false);
  const drawing = drawingProp ?? drawingLocal;
  const setDrawing = useCallback(
    (on: boolean) => {
      if (onDrawingChange) onDrawingChange(on);
      else setDrawingLocal(on);
    },
    [onDrawingChange],
  );
  const [tool, setTool] = useDrawingTool();
  const [inkState, setInkState] = useState<InkState | null>(null);
  // Touch web: the formatting bar only shows while the editor is focused (with a pointer it
  // is always there). Tapping a bar button briefly blurs the editor (then the action
  // refocuses it), so hiding is delayed a beat to avoid a flicker — a toolbar tap never
  // dismisses the bar it lives in.
  const [editorFocused, setEditorFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleFocusChange = useCallback((focused: boolean) => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
    if (focused) setEditorFocused(true);
    else blurTimer.current = setTimeout(() => setEditorFocused(false), 200);
  }, []);
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  // Selecting a note focuses its body — the title is already written, the cursor belongs
  // where you keep typing. The editor is keyed by note id upstream, so this is focus-on-mount.
  // Never on touch (it would pop the keyboard), and never from a background tab. The focus
  // view has no nav context; it is always the visible surface.
  const visible = useContext(NavContext)?.visible ?? true;
  const bodyRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || touch || !visible) return;
    // The web editor mounts ProseMirror in its own (child) effect, so it exists by now.
    bodyRef.current?.querySelector?.<HTMLElement>(".ProseMirror")?.focus({ preventScroll: true });
    // Mount only: a later tab switch must not yank focus back into the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the relative "edited 4m ago" stamp honest while the note sits open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  // Reconcile the open editor with incoming synced versions (PLAN §7.3 editor UX): silent
  // adoption when clean, a conflict prompt when the editor has unsaved edits.
  const guard = useNoteSyncGuard({
    noteId: note.id,
    getEditorContent: () => ({ title, contentMd: contentRef.current }),
    onReseed: (n) => {
      setTitle(n.title);
      contentRef.current = n.contentMd;
      setSeed((s) => ({ key: s.key + 1, content: n.contentMd }));
    },
    onCreatedNote,
  });

  const btn = touch ? undefined : ("sm" as const);
  const glyph = touch ? 17 : 13;
  const showBar = Platform.OS === "web" && !showGraph && (touch ? editorFocused : true);

  return (
    <View style={{ flex: 1 }}>
      {/* note sub-toolbar */}
      {showToolbar ? (
      <View style={[styles.subToolbar, touch ? styles.subToolbarTouch : null]}>
        <Badge tone="accent" label={note.version === 0 ? "unsynced" : "v" + note.version} />
        <Text variant="mono" tone="quaternary" numberOfLines={1}>
          edited {timeAgo(note.updatedAt)}
        </Text>
        <View style={{ flex: 1 }} />
        <IconButton label="Move to an area or project" size={btn} onPress={() => setShowProjects(true)}>
          <Icon name="folder" size={glyph} color={colors.textSecondary} />
        </IconButton>
        <IconButton
          label={drawing ? "Stop drawing" : "Draw on note"}
          size={btn}
          active={drawing && !showGraph}
          onPress={() => {
            setShowGraph(false);
            setDrawing(!drawing || showGraph);
          }}
        >
          <Icon name="pen" size={glyph} color={drawing && !showGraph ? colors.textAccent : colors.textSecondary} />
        </IconButton>
        <IconButton
          label={showGraph ? "Show document" : "Show note graph"}
          size={btn}
          active={showGraph}
          onPress={() => setShowGraph((v) => !v)}
        >
          <Icon name="graph" size={glyph} color={showGraph ? colors.textAccent : colors.textSecondary} />
        </IconButton>
        <IconButton
          label={showMeta ? "Hide metadata" : "Show metadata"}
          size={btn}
          active={showMeta}
          onPress={() => setShowMeta((v) => !v)}
        >
          <Icon name="panelRight" size={glyph} color={showMeta ? colors.textAccent : colors.textSecondary} />
        </IconButton>
        {onPopOut ? (
          <IconButton label="Open in tab" size={btn} onPress={() => onPopOut(note.id)}>
            <Icon name="external" size={glyph} color={colors.textSecondary} />
          </IconButton>
        ) : null}
        {onDelete ? (
          <IconButton label="Delete note" size={btn} onPress={() => setConfirmDelete(true)}>
            <Icon name="trash" size={glyph} color={colors.textSecondary} />
          </IconButton>
        ) : null}
      </View>
      ) : null}

      {/* Content and the metadata side panel sit side by side; the panel is toggled. */}
      <View style={styles.body}>
        {/* The document column: the scrolling page, then the formatting bar pinned under it. */}
        <View style={styles.main}>
          {showGraph ? (
            // RNW View is position:relative, giving the absolutely-filled graph canvas a size.
            <View style={{ flex: 1 }}>
              <NoteGraph noteId={note.id} />
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={touch ? styles.pageTouch : styles.page}>
              <View style={styles.doc}>
                <DocTitleField
                  value={title}
                  placeholder="Untitled"
                  onChangeText={(t) => {
                    setTitle(t);
                    onChange(note.id, { title: t });
                  }}
                  // Enter in the title carries on into the body.
                  onSubmit={() => bodyRef.current?.querySelector?.<HTMLElement>(".ProseMirror")?.focus()}
                />
                <View style={styles.metaLine}>
                  <Text variant="mono" tone="tertiary">
                    {note.date ? `daily note · ${note.date}` : `note · ${note.id.slice(0, 8)}`}
                  </Text>
                  <ArchetypeChip
                    kind="note"
                    objectTypeId={note.objectTypeId}
                    onSetType={(typeId) => void notes.update(note.id, { objectTypeId: typeId })}
                    onClearType={() => void notes.update(note.id, { clearObjectType: true, props: {} })}
                  />
                </View>
                {/* Structured props (PLAN §6.3). With the sub-toolbar these live in the metadata
                    side panel; a host that turned it off has no toggle, so once a type is set
                    they show inline (as TaskEditor does). */}
                {!showToolbar && note.objectTypeId ? (
                  <View style={styles.inlineMeta}>
                    <ObjectMetadataPanel
                      objectTypeId={note.objectTypeId}
                      props={note.props}
                      onChangeProps={(next) => void notes.update(note.id, { props: next })}
                    />
                  </View>
                ) : null}
                {/* A callback ref: on web the View is its DOM node, which is all the autofocus needs. */}
                <View
                  ref={(el: unknown) => {
                    bodyRef.current = el as HTMLElement | null;
                  }}
                >
                  <Editor
                    key={seed.key}
                    ref={editorRef}
                    markdown={seed.content}
                    onChangeMarkdown={(md) => {
                      contentRef.current = md;
                      onChange(note.id, { contentMd: md });
                    }}
                    linkSource={linkSource}
                    documentSource={documentSource}
                    onOpenRef={onOpenRef}
                    onQuickCreate={quickCreate.onQuickCreate}
                    onFormatStateChange={setFormatState}
                    onFocusChange={handleFocusChange}
                    // Desktop injects a Wails-backed native table menu; web leaves it undefined and the
                    // editor uses its built-in HTML popup.
                    tableMenuPresenter={tableMenuPresenter()}
                    // `tasks.tasks` gets a fresh identity whenever any task changes (local edit or a
                    // synced pull), signalling the editor to re-hydrate its `[[task:…]]` chips.
                    linkRevision={tasks.tasks}
                    ink={{
                      groups: ink.groups,
                      tool: drawing ? tool : null,
                      onSave: ink.save,
                      onDelete: ink.remove,
                      onStateChange: setInkState,
                      onExitRequest: () => setDrawing(false),
                    }}
                  />
                </View>
              </View>
            </ScrollView>
          )}

          {/* Web/desktop formatting bar (native uses its own keyboard toolbar). Includes the
              file-embed action when a documentSource is wired. While drawing, the drawing bar
              takes its place. */}
          {drawing && !showGraph ? (
            <DrawingBar
              tool={tool}
              onChange={setTool}
              state={inkState}
              onUndo={() => editorRef.current?.inkUndo()}
              onRedo={() => editorRef.current?.inkRedo()}
              onDone={() => setDrawing(false)}
            />
          ) : showBar ? (
            <FormattingBar state={formatState} editorRef={editorRef} canAttach={!!documentSource} />
          ) : null}
        </View>

        {showMeta && showToolbar ? (
          <MetadataSidePanel
            objectTypeId={note.objectTypeId}
            props={note.props}
            onChangeProps={(next) => void notes.update(note.id, { props: next })}
            onClose={() => setShowMeta(false)}
          />
        ) : null}
      </View>

      {quickCreate.dialog}

      {showProjects ? (
        <MembershipPicker entityType="note" entityId={note.id} onClose={() => setShowProjects(false)} />
      ) : null}

      {onDelete && confirmDelete ? (
        <ConfirmDialog
          title="Delete note?"
          message="This note moves to the Trash and is permanently deleted after 30 days. You can restore it from the Trash until then."
          confirmLabel="Delete note"
          onConfirm={() => onDelete(note.id)}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}

      {guard.conflict ? (
        <NoteConflictDialog
          kind={guard.conflict}
          onDiscard={guard.discard}
          onSaveAsNew={guard.saveAsNewNote}
          onRestore={guard.restore}
        />
      ) : null}
    </View>
  );
}

const styles = {
  // 28px sub-toolbar with a bottom hairline; icon buttons are `sm` with 13px glyphs.
  subToolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  // Touch density: a 44px bar of `lg` buttons.
  subToolbarTouch: { height: row.touch, paddingLeft: space.xl, paddingRight: space.md },
  body: { flex: 1, flexDirection: "row" as const, minHeight: 0 },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  // Page gutters: 20px top / 28px sides with a pointer, a 20px inset on a phone.
  page: { paddingTop: space.xl2, paddingHorizontal: 28, paddingBottom: space.huge },
  pageTouch: { paddingTop: space.xl, paddingHorizontal: space.xl2, paddingBottom: space.huge },
  // The document column, centered in the page.
  doc: { maxWidth: layout.contentMax, width: "100%" as const, alignSelf: "center" as const },
  // Inline structured fields (toolbar-less hosts): a hairline-ruled block above the body.
  inlineMeta: {
    marginBottom: space.xl,
    paddingBottom: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  // The mono meta line and the archetype chip share a line under the title.
  metaLine: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    flexWrap: "wrap" as const,
    gap: space.sm,
    marginTop: space.sm,
    marginBottom: space.xl,
    // The chip's type picker floats below this line; keep it above the editor body.
    zIndex: 1,
  },
};
