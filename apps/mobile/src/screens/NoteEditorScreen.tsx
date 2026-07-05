import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCore, useNotes } from '@companion/app';
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
  // Seed the editor once. The prop must NOT track the live note (saves update it
  // optimistically on every keystroke); the WebView owns its content after mount and
  // reports changes back out. A changing markdown prop re-injects on every keystroke
  // and crashes the DOM view.
  const [initialMarkdown] = useState(() => note?.contentMd ?? '');

  // `store` gets a new identity on every save (its useMemo tracks `notes`), so route
  // through a ref and give the DOM component / header callbacks stable identities that
  // depend only on the note id.
  const storeRef = useRef(store);
  storeRef.current = store;
  const onChangeMarkdown = useCallback(
    (md: string) => storeRef.current.save(noteId, { contentMd: md }),
    [noteId],
  );

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
      <Editor markdown={initialMarkdown} onChangeMarkdown={onChangeMarkdown} linkSource={linkSource} />
    ),
    [initialMarkdown, onChangeMarkdown, linkSource],
  );

  // Deps exclude note/store so content edits don't re-run setOptions; only the title
  // (shown in the header) does.
  useLayoutEffect(() => {
    nav.setOptions({
      title: title || 'Untitled',
      headerRight: () => (
        <View style={styles.headerActions}>
          <IconButton
            label="Note graph"
            size="sm"
            onPress={() => nav.navigate('NoteGraph', { id: noteId })}
          >
            <Icon name="graph" size={18} color={colors.textSecondary} />
          </IconButton>
          <IconButton
            label="Delete note"
            size="sm"
            onPress={async () => {
              await storeRef.current.remove(noteId);
              nav.goBack();
            }}
          >
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceCard },
  title: { paddingHorizontal: space.lg, paddingTop: space.md },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
