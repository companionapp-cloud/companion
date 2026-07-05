import { useMemo, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import type { Note } from "@companion/core-bridge";
import { Badge, Icon, IconButton, Text, TextField, colors, layout, space } from "@companion/design-system";
import { Editor, type LinkSource } from "@companion/editor";
import { useCore } from "./CoreContext";
import { NoteGraph } from "./NoteGraph";

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
}

/** The document-style editor for a single note: a sub-toolbar of note-scoped actions,
 * the title, and a ProseMirror body (from @companion/editor). App-level chrome stays in
 * the app toolbar. Keyed by note id upstream, so each note gets a fresh instance. */
export function NoteEditor({ note, onChange, onPopOut, onDelete }: NoteEditorProps) {
  const { graph } = useCore();
  // Wikilink autocomplete ([[) and pasted-UUID resolution search the object graph.
  const linkSource = useMemo<LinkSource>(
    () => ({
      search: async (q, type) =>
        (await graph.search(q, type)).map((n) => ({ type: n.type, id: n.id, title: n.title })),
      lookup: async (id) => {
        const n = await graph.lookup(id);
        return n ? { type: n.type, id: n.id, title: n.title } : null;
      },
    }),
    [graph],
  );
  const [title, setTitle] = useState(note.title);
  // Seed the editor once; it owns its content thereafter and reports edits back out.
  const [initialContent] = useState(() => note.contentMd);
  // Toggle between the document and this note's link graph (centered on the note).
  const [showGraph, setShowGraph] = useState(false);

  return (
    <View style={{ flex: 1 }}>
      {/* note sub-toolbar */}
      <View style={styles.subToolbar}>
        <Badge tone="accent" label={note.version === 0 ? "unsynced" : "v" + note.version} />
        <View style={{ flex: 1 }} />
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
          <IconButton label="Delete note" size="sm" onPress={() => onDelete(note.id)}>
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
            markdown={initialContent}
            onChangeMarkdown={(md) => onChange(note.id, { contentMd: md })}
            linkSource={linkSource}
          />
        </ScrollView>
      )}
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
