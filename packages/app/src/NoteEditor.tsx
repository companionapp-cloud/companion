import { useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import type { Note } from "@companion/core-bridge";
import { Badge, Icon, IconButton, Text, TextField, colors, layout, space } from "@companion/design-system";
import { Editor, type LinkRef } from "@companion/editor";
import { useTasks } from "./TasksProvider";
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
  // Project membership picker overlay for this note (PLAN §6.6).
  const [showProjects, setShowProjects] = useState(false);
  // Delete is irreversible, so gate it behind a confirmation.
  const [confirmDelete, setConfirmDelete] = useState(false);

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
          <Text variant="mono" tone="tertiary" style={{ marginTop: space.md, marginBottom: space.xl }}>
            Edited {new Date(note.updatedAt).toLocaleString()}
          </Text>
          <Editor
            key={seed.key}
            markdown={seed.content}
            onChangeMarkdown={(md) => {
              contentRef.current = md;
              onChange(note.id, { contentMd: md });
            }}
            linkSource={linkSource}
            onOpenRef={onOpenRef}
            // `tasks.tasks` gets a fresh identity whenever any task changes (local edit or a
            // synced pull), signalling the editor to re-hydrate its `[[task:…]]` chips.
            linkRevision={tasks.tasks}
          />
        </ScrollView>
      )}

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
  doc: {
    maxWidth: layout.contentMax,
    width: "100%" as const,
    marginHorizontal: "auto" as const,
    padding: DOC_PAD,
    paddingTop: DOC_PAD_TOP,
  },
};
