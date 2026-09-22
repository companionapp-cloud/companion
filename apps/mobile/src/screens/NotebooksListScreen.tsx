import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { NotebookShelf, NotebookCoverDialog, useNotebooks, toShelfNotebook, useShelfCoverUrls, DocumentSourceProvider } from '@companion/app';
import { Spinner, colors } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useNativeDocumentSource } from '../useNativeDocumentSource';
import { Fab } from '../ui/native';

// The notebooks shelf (PLAN-notebooks.md §2): journals one to a row, tap to open, + to make one.
export function NotebooksListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const notebooks = useNotebooks();
  const documentSource = useNativeDocumentSource();
  const [editId, setEditId] = useState<string | null>(null);
  const shelf = useMemo(() => notebooks.notebooks.map(toShelfNotebook), [notebooks.notebooks]);
  const create = async () => {
    const nb = await notebooks.create();
    setEditId(nb.id);
  };
  return (
    <DocumentSourceProvider documentSource={documentSource}>
      <View style={styles.root}>
        {notebooks.loading ? (
          <Spinner label="Loading your notebooks…" />
        ) : (
          <Shelf shelf={shelf} onOpen={(id) => nav.push('Notebook', { id })} onCreate={() => void create()} onEdit={setEditId} />
        )}
        <Fab label="New notebook" onPress={() => void create()} />
        {editId ? <NotebookCoverDialog notebookId={editId} onClose={() => setEditId(null)} /> : null}
      </View>
    </DocumentSourceProvider>
  );
}

function Shelf({ shelf, onOpen, onCreate, onEdit }: { shelf: ReturnType<typeof toShelfNotebook>[]; onOpen(id: string): void; onCreate(): void; onEdit(id: string): void }) {
  const notebooks = useNotebooks();
  const coverUrls = useShelfCoverUrls(notebooks.notebooks);
  return <NotebookShelf notebooks={shelf} coverUrls={coverUrls} onOpen={onOpen} onCreate={onCreate} onEdit={onEdit} />;
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.surfaceApp } });
