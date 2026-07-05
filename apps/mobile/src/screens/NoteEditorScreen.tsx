import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCore, useNotes, MembershipPicker, ConfirmDialog, NoteConflictDialog, useNoteSyncGuard } from '@companion/app';
import { Center, Icon, IconButton, Text, TextField, colors, space } from '@companion/design-system';
import { Editor, type LinkSource } from '@companion/editor';
import type { RootStackParamList } from '../MobileShell';

// Full-screen editor for one note (pushed above the tab bar): a native title field
// over the ProseMirror body (a WebView). Delete lives in the nav header.
export function NoteEditorScreen() {
  const store = useNotes();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'NoteEditor'>>();
  const noteId = params.id;
  const note = store.byId(noteId);
  const [title, setTitle] = useState(note?.title ?? '');
  const [showProjects, setShowProjects] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Seed the editor from `seed.content`; the WebView owns its content after mount and
  // reports changes back out (a changing markdown prop re-injects on every keystroke and
  // crashes the DOM view). `seed.key` remounts the WebView when the sync guard silently
  // adopts a server version.
  const [seed, setSeed] = useState(() => ({ key: 0, content: note?.contentMd ?? '' }));
  // The editor's latest reported markdown, read when saving local edits as a new note.
  const contentRef = useRef(note?.contentMd ?? '');

  // `store` gets a new identity on every save (its useMemo tracks `notes`), so route
  // through a ref and give the DOM component / header callbacks stable identities that
  // depend only on the note id.
  const storeRef = useRef(store);
  storeRef.current = store;
  const onChangeMarkdown = useCallback(
    (md: string) => {
      contentRef.current = md;
      storeRef.current.save(noteId, { contentMd: md });
    },
    [noteId],
  );

  // Reconcile the open editor with incoming synced versions (PLAN §7.3 editor UX).
  const guard = useNoteSyncGuard({
    noteId,
    getEditorContent: () => ({ title, contentMd: contentRef.current }),
    onReseed: (n) => {
      setTitle(n.title);
      contentRef.current = n.contentMd;
      setSeed((s) => ({ key: s.key + 1, content: n.contentMd }));
    },
    onGone: () => nav.goBack(),
    onCreatedNote: (id) => nav.push('NoteEditor', { id }),
  });

  // Wikilink autocomplete ([[) + pasted-UUID resolution search the object graph. Stable
  // identity (graph is memoized on the core) so it doesn't reload the WebView.
  const { graph } = useCore();
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

  // Memoized so parent re-renders (title state, optimistic store updates) don't reload
  // the WebView; it's built once from the initial content and reports edits back out.
  const body = useMemo(
    () => (
      <Editor key={seed.key} markdown={seed.content} onChangeMarkdown={onChangeMarkdown} linkSource={linkSource} />
    ),
    [seed.key, seed.content, onChangeMarkdown, linkSource],
  );

  // Deps exclude note/store so content edits don't re-run setOptions; only the title
  // (shown in the header) does.
  useLayoutEffect(() => {
    nav.setOptions({
      title: title || 'Untitled',
      headerRight: () => (
        <View style={styles.headerActions}>
          <IconButton label="Add to projects" size="sm" onPress={() => setShowProjects(true)}>
            <Icon name="folder" size={18} color={colors.textSecondary} />
          </IconButton>
          <IconButton
            label="Note graph"
            size="sm"
            onPress={() => nav.navigate('NoteGraph', { id: noteId })}
          >
            <Icon name="graph" size={18} color={colors.textSecondary} />
          </IconButton>
          <IconButton label="Delete note" size="sm" onPress={() => setConfirmDelete(true)}>
            <Icon name="trash" size={18} color={colors.textSecondary} />
          </IconButton>
        </View>
      ),
    });
  }, [nav, noteId, title]);

  if (!note) {
    return (
      <Center>
        <Text tone="tertiary">This note is gone.</Text>
      </Center>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.title}>
        <TextField
          variant="title"
          value={title}
          placeholder="Untitled"
          onChangeText={(t) => {
            setTitle(t);
            store.save(noteId, { title: t });
          }}
        />
      </View>
      {body}
      {showProjects ? (
        <MembershipPicker entityType="note" entityId={noteId} onClose={() => setShowProjects(false)} />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete note?"
          message="This note moves to the Trash and is permanently deleted after 30 days. You can restore it from the Trash until then."
          confirmLabel="Delete note"
          onConfirm={async () => {
            await storeRef.current.remove(noteId);
            nav.goBack();
          }}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceCard },
  // 20px matches the editor body's horizontal inset on mobile (.pm-wrap in
  // packages/editor/src/styles.ts) so the title lines up with the content beneath it.
  title: { paddingHorizontal: 20, paddingTop: space.md },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
