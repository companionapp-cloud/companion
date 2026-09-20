import { useMemo } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ContainerHome,
  NavContext,
  docOfRef,
  useContainerContent,
  useProjects,
  useToolVisibility,
  type ContainerRef,
  type Navigator,
  type ProjectSection,
  type TabRef,
} from '@companion/app';
import type { RootStackParamList } from '../MobileShell';
import { useAreaScope, useProjectScope } from '../ProjectContext';
import { useNativeDocumentSource } from '../useNativeDocumentSource';

// The tab a section lives on inside a project's or an area's tab navigator.
const PROJECT_TAB: Partial<Record<ProjectSection, string>> = {
  notes: 'ProjectNotes',
  tasks: 'ProjectTasks',
  canvases: 'ProjectCanvases',
  calendars: 'ProjectCalendar',
};
const AREA_TAB: Partial<Record<ProjectSection, string>> = { notes: 'AreaNotes', tasks: 'AreaTasks', canvases: 'AreaCanvases' };

/** The Overview tab of a project or an area (PLAN-areas.md §3): the shared overview page —
 * cover, emoji, description, then the cards — at touch density. The page navigates through the
 * app's Navigator contract, which this shell doesn't otherwise provide, so the handful of
 * moves an overview makes are mapped onto the stack here: an item opens as its full-screen
 * editor, "View all" switches to the sibling tab, a project pushes its own screen. */
export function ContainerOverviewScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useProjectScope();
  const areaId = useAreaScope();
  const container = useMemo<ContainerRef | null>(
    () => (projectId ? { kind: 'project', id: projectId } : areaId ? { kind: 'area', id: areaId } : null),
    [projectId, areaId],
  );
  const { areas, projects } = useProjects();
  const { hidden } = useToolVisibility();
  const content = useContainerContent(container);
  const documentSource = useNativeDocumentSource();

  const navigator = useMemo(() => {
    const openDoc = (kind: 'note' | 'task' | 'canvas', id: string) => {
      if (kind === 'note') nav.push('NoteEditor', { id });
      else if (kind === 'task') nav.push('TaskEditor', { id });
      else nav.push('Canvas', { id });
    };
    const openRef = (ref: TabRef | null) => {
      const doc = docOfRef(ref);
      if (doc) openDoc(doc.kind, doc.id);
      else if (ref?.kind === 'project') nav.push('Project', { projectId: ref.projectId });
      else if (ref?.kind === 'area') nav.push('Area', { areaId: ref.areaId });
    };
    const partial: Partial<Navigator> = {
      visible: true,
      back: () => nav.goBack(),
      openNote: (id) => openDoc('note', id),
      openTask: (id) => openDoc('task', id),
      openCanvas: (id) => openDoc('canvas', id),
      openRef,
      openInNewTab: openRef,
      openProject: (id) => nav.push('Project', { projectId: id }),
      openArea: (id) => nav.push('Area', { areaId: id }),
      openContainer: (target, section, itemId) => {
        if (section && itemId) {
          const kind = section === 'notes' ? 'note' : section === 'canvases' ? 'canvas' : 'task';
          return openDoc(kind, itemId);
        }
        const tab = section ? (target.kind === 'area' ? AREA_TAB : PROJECT_TAB)[section] : undefined;
        // This screen is a tab of the container it shows, so its sections are sibling tabs.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (tab) (nav as any).navigate(tab);
      },
    };
    return partial as Navigator;
  }, [nav]);

  if (!container) return null;
  const page = container.kind === 'area' ? areas.find((a) => a.id === container.id) : projects.find((p) => p.id === container.id);
  if (!page) return null;
  const sections = (['notes', 'tasks', 'canvases'] as const).filter((s) => !hidden.has(s));

  return (
    <NavContext.Provider value={navigator}>
      <ContainerHome
        container={container}
        page={page}
        notes={content.notes}
        tasks={content.tasks}
        canvases={content.canvases}
        members={content.members}
        projectOf={content.projectOf}
        sections={[...sections]}
        onViewTasks={() => navigator.openContainer(container, 'tasks')}
        documentSource={documentSource}
      />
    </NavContext.Provider>
  );
}
