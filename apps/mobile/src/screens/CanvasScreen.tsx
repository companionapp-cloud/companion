import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { CanvasPane, DocumentSourceProvider } from '@companion/app';
import { colors } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useNativeDocumentSource } from '../useNativeDocumentSource';

// A canvas board, full screen (PLAN-canvases.md §5): the shared pane (name, projects,
// delete) over the WebView-hosted React Flow editor. The native document source lets image
// cards resolve their bytes and the OS picker add new images.
//
// The nav bar only names the screen: the pane's own row carries the board's editable
// name, so repeating it here would print it twice. The touch chrome — the 48px bottom
// tool bar (sticky / group / connect / undo) and its More sheet of embeddables — is drawn
// by the board itself inside the WebView whenever the pointer is coarse, and it handles
// the bottom safe-area inset in-board. So this screen adds no bottom chrome or padding:
// the pane runs edge to edge beneath the bar.
export function CanvasScreen({ route }: NativeStackScreenProps<RootStackParamList, 'Canvas'>) {
  const { id } = route.params;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const documentSource = useNativeDocumentSource();

  const onOpenRef = useCallback(
    (ref: { type: 'note' | 'task' | 'event'; id: string }) => {
      if (ref.type === 'note') nav.push('NoteEditor', { id: ref.id });
      else if (ref.type === 'task') nav.push('TaskEditor', { id: ref.id });
      else nav.navigate('Calendar');
    },
    [nav],
  );

  return (
    <DocumentSourceProvider documentSource={documentSource}>
      <View style={styles.root}>
        <CanvasPane key={id} canvasId={id} onDeleted={() => nav.goBack()} onOpenRef={onOpenRef} />
      </View>
    </DocumentSourceProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
});
