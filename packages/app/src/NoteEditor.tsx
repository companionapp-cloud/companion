import { useRef, useState, type RefObject } from "react";
import { Platform, ScrollView, View } from "react-native";
import type { Note } from "@companion/core-bridge";
import { Badge, Icon, IconButton, Text, TextField, colors, layout, space } from "@companion/design-system";
import { Editor, type EditorController, type FormatName, type FormatState, type LinkRef } from "@companion/editor";
import type { IconName } from "@companion/design-system";
import { useTasks } from "./TasksProvider";
import { useNotes } from "./NotesProvider";
import { ArchetypeChip, MetadataSidePanel } from "./ArchetypeSection";
import { useLinkSource } from "./useLinkSource";
import { NoteGraph } from "./NoteGraph";
import { MembershipPicker } from "./MembershipPicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { NoteConflictDialog } from "./NoteConflictDialog";
import { useNoteSyncGuard } from "./useNoteSyncGuard";

// The document reads as a roomy page on web/desktop, but that much padding is cramping
// on a phone-width screen, so tighten it on native.
const DOC_PAD = Platform.OS === "web" ? 44 : 20;
const DOC_PAD_TOP = Platform.OS === "web" ? 32 : 16;

export interface NoteEditorProps {
  note: Note;
  onChange: (id: string, fields: { title?: string; contentMd?: string }) => void;
  /** Shown as a pop-out (focus) action in the note's sub-toolbar when provided. */
  onPopOut?: (id: string) => void;
  /** Shown as a delete action in the note's sub-toolbar when provided. */
  onDelete?: (id: string) => void;
  /** Called with the id of a note created from "save my changes as a new note" during a
   *  sync-conflict resolution, so the host can open it. */
  onCreatedNote?: (id: string) => void;
  /** Open a wikilink target the reader clicked (e.g. a `[[task:…]]` chip) — the host puts
   *  it in a new workspace tab. */
  onOpenRef?: (ref: LinkRef) => void;
}

/** The document-style editor for a single note: a sub-toolbar of note-scoped actions,
 * the title, and a ProseMirror body (from @companion/editor). App-level chrome stays in
 * the app toolbar. Keyed by note id upstream, so each note gets a fresh instance. */
export function NoteEditor({ note, onChange, onPopOut, onDelete, onCreatedNote, onOpenRef }: NoteEditorProps) {
  // Task metadata (for `[[task:…]]` chip hydration) also refreshes the chips; `tasks.tasks`
  // identity changes on any task edit, which we pass as linkRevision below.
  const tasks = useTasks();
  const notes = useNotes();
  // Wikilink autocomplete ([[) and pasted-UUID resolution search the object graph.
  const linkSource = useLinkSource();
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
  // Web/desktop: the formatting bar floats over the editor while text is selected. The
  // editor reports which toggles are active/available; the ref drives them. (On native the
  // editor renders its own keyboard-anchored toolbar, so this stays dormant.)
  const editorRef = useRef<EditorController>(null);
  const [formatState, setFormatState] = useState<FormatState | null>(null);

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

  return (
    <View style={{ flex: 1 }}>
      {/* note sub-toolbar */}
      <View style={styles.subToolbar}>
        <Badge tone="accent" label={note.version === 0 ? "unsynced" : "v" + note.version} />
        <View style={{ flex: 1 }} />
        <IconButton label="Add to projects" size="sm" onPress={() => setShowProjects(true)}>
          <Icon name="folder" size={16} color={colors.textTertiary} />
        </IconButton>
        <IconButton
          label={showGraph ? "Show document" : "Show note graph"}
          size="sm"
          active={showGraph}
          onPress={() => setShowGraph((v) => !v)}
        >
          <Icon name="graph" size={16} color={showGraph ? colors.accentHover : colors.textTertiary} />
        </IconButton>
        <IconButton
          label={showMeta ? "Hide metadata" : "Show metadata"}
          size="sm"
          active={showMeta}
          onPress={() => setShowMeta((v) => !v)}
        >
          <Icon name="panelRight" size={16} color={showMeta ? colors.accentHover : colors.textTertiary} />
        </IconButton>
        {onPopOut ? (
          <IconButton label="Open in new window" size="sm" onPress={() => onPopOut(note.id)}>
            <Icon name="external" size={15} color={colors.textTertiary} />
          </IconButton>
        ) : null}
        {onDelete ? (
          <IconButton label="Delete note" size="sm" onPress={() => setConfirmDelete(true)}>
            <Icon name="trash" size={16} color={colors.textTertiary} />
          </IconButton>
        ) : null}
      </View>

      {/* Content and the metadata side panel sit side by side; the panel is toggled. */}
      <View style={styles.body}>
        {showGraph ? (
          // RNW View is position:relative, giving the absolutely-filled graph canvas a size.
          <View style={{ flex: 1 }}>
            <NoteGraph noteId={note.id} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.doc}>
            <TextField
              variant="title"
              value={title}
              placeholder="Untitled"
              onChangeText={(t) => {
                setTitle(t);
                onChange(note.id, { title: t });
              }}
            />
            <View style={styles.metaLine}>
              <Text variant="mono" tone="tertiary">
                Edited {new Date(note.updatedAt).toLocaleString()}
              </Text>
              <ArchetypeChip
                kind="note"
                objectTypeId={note.objectTypeId}
                onSetType={(typeId) => void notes.update(note.id, { objectTypeId: typeId })}
                onClearType={() => void notes.update(note.id, { clearObjectType: true, props: {} })}
              />
            </View>
            <Editor
              key={seed.key}
              ref={editorRef}
              markdown={seed.content}
              onChangeMarkdown={(md) => {
                contentRef.current = md;
                onChange(note.id, { contentMd: md });
              }}
              linkSource={linkSource}
              onOpenRef={onOpenRef}
              onFormatStateChange={setFormatState}
              // `tasks.tasks` gets a fresh identity whenever any task changes (local edit or a
              // synced pull), signalling the editor to re-hydrate its `[[task:…]]` chips.
              linkRevision={tasks.tasks}
            />
          </ScrollView>
        )}

        {/* Web/desktop selection formatting bar (native uses its own keyboard toolbar). */}
        {Platform.OS === "web" && !showGraph && formatState?.hasSelection ? (
          <FormattingBar state={formatState} editorRef={editorRef} />
        ) : null}

        {showMeta ? (
          <MetadataSidePanel
            objectTypeId={note.objectTypeId}
            props={note.props}
            onChangeProps={(next) => void notes.update(note.id, { props: next })}
            onClose={() => setShowMeta(false)}
          />
        ) : null}
      </View>

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

// The formatting actions shown in the web selection bar, in order (mirrors the native
// keyboard toolbar in @companion/editor). Insert-reference is prepended separately.
const FORMAT_BUTTONS: { name: FormatName; icon: IconName; label: string }[] = [
  { name: "bold", icon: "bold", label: "Bold" },
  { name: "italic", icon: "italic", label: "Italic" },
  { name: "strike", icon: "strikethrough", label: "Strikethrough" },
  { name: "code", icon: "code", label: "Code" },
  { name: "codeBlock", icon: "codeBlock", label: "Code block" },
  { name: "blockquote", icon: "quote", label: "Blockquote" },
  { name: "bulletList", icon: "listBullet", label: "Bulleted list" },
  { name: "orderedList", icon: "listOrdered", label: "Numbered list" },
];

/** Web/desktop: a floating bar of formatting toggles anchored to the bottom of the editor,
 * shown while text is selected. Drives the editor through its imperative handle. */
function FormattingBar({
  state,
  editorRef,
}: {
  state: FormatState;
  editorRef: RefObject<EditorController | null>;
}) {
  return (
    <View style={styles.formatBar} pointerEvents="box-none">
      <View style={styles.formatBarInner}>
        <IconButton label="Insert reference" size="sm" onPress={() => editorRef.current?.insertReference()}>
          <Icon name="link" size={17} color={colors.textSecondary} />
        </IconButton>
        <View style={styles.formatBarDivider} />
        {FORMAT_BUTTONS.map((b) => {
          const active = state.active[b.name];
          return (
            <IconButton
              key={b.name}
              label={b.label}
              size="sm"
              active={active}
              disabled={!state.enabled[b.name]}
              onPress={() => editorRef.current?.format(b.name)}
            >
              <Icon name={b.icon} size={17} color={active ? colors.accentHover : colors.textSecondary} />
            </IconButton>
          );
        })}
      </View>
    </View>
  );
}

const styles = {
  subToolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: 44,
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  body: { flex: 1, flexDirection: "row" as const, minHeight: 0 },
  doc: {
    maxWidth: layout.contentMax,
    width: "100%" as const,
    marginHorizontal: "auto" as const,
    padding: DOC_PAD,
    paddingTop: DOC_PAD_TOP,
  },
  // Floating formatting bar, centered along the bottom of the editor (web/desktop).
  formatBar: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: space.lg,
    alignItems: "center" as const,
  },
  formatBarInner: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    borderRadius: 12,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    // A soft lift so it reads as floating above the document (web only).
    ...(Platform.OS === "web" ? { boxShadow: "0 6px 22px rgba(0,0,0,0.13)" } : null),
  },
  formatBarDivider: {
    width: 1,
    height: 20,
    marginHorizontal: space.xs,
    backgroundColor: colors.borderSubtle,
  },
  // The "Edited …" timestamp and the archetype chip share a line under the title.
  metaLine: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    flexWrap: "wrap" as const,
    gap: space.md,
    marginTop: space.md,
    marginBottom: space.lg,
  },
};
