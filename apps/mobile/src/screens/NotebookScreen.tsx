import { useLayoutEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { NotebookEditor, NotebookCoverDialog, useNotebooks, useNotebookHost, DocumentSourceProvider } from '@companion/app';
import { Icon, IconButton, colors } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useNativeDocumentSource } from '../useNativeDocumentSource';

// One notebook, full screen (PLAN-notebooks.md): the shared editor chrome around the
// WebView-hosted page view. The nav bar carries the title and the cover action.
export function NotebookScreen({ route }: NativeStackScreenProps<RootStackParamList, 'Notebook'>) {
  const { id, page } = route.params;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const notebooks = useNotebooks();
  const documentSource = useNativeDocumentSource();
  const [cover, setCover] = useState(false);
  const title = notebooks.byId(id)?.title;
  useLayoutEffect(() => {
    nav.setOptions({
      title: title || 'Untitled',
      headerRight: () => (
        <IconButton label="Title and cover" size="lg" onPress={() => setCover(true)}>
          <Icon name="moreH" size={18} color={colors.textSecondary} />
        </IconButton>
      ),
    });
  }, [nav, title]);
  return (
    <DocumentSourceProvider documentSource={documentSource}>
      <View style={styles.root}>
        <Editor id={id} page={page} onBack={() => nav.goBack()} />
        {cover ? <NotebookCoverDialog notebookId={id} onClose={() => setCover(false)} /> : null}
      </View>
    </DocumentSourceProvider>
  );
}

function Editor({ id, page, onBack }: { id: string; page?: number; onBack(): void }) {
  const host = useNotebookHost();
  return <NotebookEditor key={id} host={host} notebookId={id} onBack={onBack} showTopBar={false} initialPage={page} />;
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.surfaceApp } });
