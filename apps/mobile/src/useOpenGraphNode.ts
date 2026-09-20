import { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { docOfRef, useGraphNodeRef } from '@companion/app';
import type { RootStackParamList } from './MobileShell';

/** Opens a tapped graph node where it lives, as the shared useGraphNodeRef resolves it: a
 *  daily note in Today on its day, a project as its tab view, and anything else (a
 *  project's items included) as its full-screen editor, the way this shell's project lists
 *  open them. Pushes, so Back returns to the graph. */
export function useOpenGraphNode(): (type: string, id: string) => void {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const resolve = useGraphNodeRef();
  return useCallback(
    (type: string, id: string) => {
      void resolve(type, id).then((ref) => {
        if (!ref) return;
        if (ref.kind === 'view') {
          if (ref.view === 'today') nav.push('Today', { date: ref.date });
          return;
        }
        if (ref.kind === 'project' && !ref.itemId) {
          nav.push('Project', { projectId: ref.projectId });
          return;
        }
        if (ref.kind === 'area' && !ref.itemId) {
          nav.push('Area', { areaId: ref.areaId });
          return;
        }
        const doc = docOfRef(ref);
        if (doc?.kind === 'note') nav.push('NoteEditor', { id: doc.id });
        else if (doc?.kind === 'task') nav.push('TaskEditor', { id: doc.id });
        else if (doc?.kind === 'canvas') nav.push('Canvas', { id: doc.id });
      });
    },
    [nav, resolve],
  );
}
