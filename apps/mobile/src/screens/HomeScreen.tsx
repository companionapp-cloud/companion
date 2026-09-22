import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SidebarArea, SidebarProject } from '@companion/core-bridge';
import { useCore, useNotes, useProjects, useTasks, useNotifications, useToolVisibility, SortableList, CaptureForm, ConfirmDialog, type ToolId, TourAnchor } from '@companion/app';
import { Badge, Button, Icon, IconButton, Input, ProgressRing, Text, colors, font, radius, space, type IconName } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { BottomSheet, Card, CardRow, CountPill, FAB_CLEARANCE, Fab, IconTile, SectionLabel } from '../ui/native';

type Nav = NativeStackNavigationProp<RootStackParamList>;

type SectionRoute = 'Today' | 'Chat' | 'Notes' | 'Tasks' | 'Canvases' | 'Habits' | 'Calendar' | 'Graph' | 'Logbook' | 'Trash';
const SECTIONS: { route: SectionRoute; label: string; subtitle: string; icon: IconName; accent?: boolean }[] = [
  { route: 'Today', label: 'Today', subtitle: "Today's note and your month", icon: 'today' },
  { route: 'Chat', label: 'Chat', subtitle: 'Ask, capture, recall — anything', icon: 'chat', accent: true },
  { route: 'Notes', label: 'Notes', subtitle: 'Your graph of linked ideas', icon: 'notes' },
  { route: 'Tasks', label: 'Tasks', subtitle: 'What needs doing', icon: 'tasks' },
  { route: 'Canvases', label: 'Canvases', subtitle: 'Boards for arranging ideas', icon: 'canvas' },
  { route: 'Habits', label: 'Habits', subtitle: 'Streaks and daily builders', icon: 'habits' },
  { route: 'Calendar', label: 'Calendar', subtitle: 'Events, tasks, and notes', icon: 'calendar' },
  { route: 'Graph', label: 'Graph', subtitle: 'See how everything connects', icon: 'graph' },
  { route: 'Logbook', label: 'Logbook', subtitle: 'Completed tasks and projects', icon: 'logbook' },
  { route: 'Trash', label: 'Trash', subtitle: 'Recently deleted, kept 30 days', icon: 'trash' },
];

/** What a project row reports beside its name: member counts and task completion. */
interface ProjectCounts {
  notes: number;
  tasks: number;
  done: number;
}

/** The mobile root. It owns its title, so there is no nav bar: a large title across from
 * the notifications bell, a mono date line, one grouped card of the tool sections, then
 * the areas → projects tree as labelled cards (PLAN §6.6). A quick-add FAB opens the
 * capture sheet. Opening a project pushes its scoped tab bar. */
export function HomeScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const store = useNotes();
  const tasks = useTasks();
  const { sidebar, createArea, createProject, deleteArea, reorderAreas, reorderProjects } = useProjects();
  // Someday projects are filed away (PLAN-scheduling.md §1): off this list, shown on their area's
  // overview. `empty` still counts them — an area holding one can't be deleted.
  const areas = useMemo(
    () => sidebar.areas.map((a) => ({ ...a, empty: a.projects.length === 0, projects: a.projects.filter((p) => !p.someday) })),
    [sidebar.areas],
  );

  const [addingArea, setAddingArea] = useState(false);
  const [areaName, setAreaName] = useState('');
  const [addingProjectFor, setAddingProjectFor] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [capture, setCapture] = useState(false);
  // The empty area pending deletion (its confirm dialog renders over the screen).
  const [deletingArea, setDeletingArea] = useState<SidebarArea | null>(null);
  // Reorder mode: toggled by the header "Edit" button. While on, rows drag to reorder
  // (areas among themselves, projects within their area) and tap-to-open is suspended.
  const [editing, setEditing] = useState(false);
  // True during an active drag, so the ScrollView stops scrolling and doesn't fight it.
  const [dragging, setDragging] = useState(false);

  const submitArea = async () => {
    const name = areaName.trim();
    setAreaName('');
    setAddingArea(false);
    if (name) await createArea({ name });
  };
  const submitProject = async (areaId: string) => {
    const name = projectName.trim();
    setProjectName('');
    setAddingProjectFor(null);
    if (name) await createProject({ areaId, name });
  };

  const openProject = (id: string) => nav.navigate('Project', { projectId: id });

  // Per-device tool hiding + ordering (Settings › Tools): the home sections card is
  // mobile's sidebar-equivalent, so hidden tools drop out of it and its rows follow the
  // saved order. Reorder mode drags rows; the new order persists via `reorder`.
  const { tools, hidden, reorder } = useToolVisibility();
  const orderIndex = new Map(tools.map((t, i) => [t.id, i]));
  const toolId = (route: SectionRoute): ToolId => route.toLowerCase() as ToolId;
  const sections = SECTIONS.filter((s) => !hidden.has(toolId(s.route))).sort(
    (a, b) => (orderIndex.get(toolId(a.route)) ?? 0) - (orderIndex.get(toolId(b.route)) ?? 0),
  );

  const openTasks = useMemo(() => tasks.tasks.filter((t) => t.status !== 'done').length, [tasks.tasks]);
  const counts = useProjectCounts(sidebar);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Text style={styles.greeting} numberOfLines={1}>
          What’s new today?
        </Text>
        <Button label={editing ? 'Done' : 'Edit'} variant="ghost" onPress={() => setEditing((v) => !v)} />
        <BellButton onPress={() => nav.navigate('Notifications')} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + space.xl + FAB_CLEARANCE }]}
        showsVerticalScrollIndicator={false}
        scrollEnabled={!dragging}
      >
        <Text variant="mono" tone="tertiary" style={styles.date}>
          {dateLabel()}
        </Text>

        <Card>
          <SortableList
            items={sections}
            keyExtractor={(s) => s.route}
            enabled={editing}
            activateOnStart
            onDragActiveChange={setDragging}
            onReorder={(routes) => void reorder(routes.map((r) => toolId(r as SectionRoute)))}
            renderItem={({ item: s, index, drag }) => (
              <CardRow
                leading={
                  <IconTile variant={s.accent ? 'accent' : 'neutral'}>
                    <Icon name={s.icon} size={20} color={s.accent ? colors.accent : colors.textSecondary} />
                  </IconTile>
                }
                title={s.label}
                subtitle={s.subtitle}
                trailing={
                  editing ? (
                    // The handle claims the touch so the ScrollView can't steal the pan;
                    // the rest of the row is inert while reordering.
                    <View {...drag} style={styles.dragHandle} aria-label={`Reorder ${s.label}`}>
                      <Icon name="moreH" size={18} color={colors.textTertiary} />
                    </View>
                  ) : s.route === 'Notes' ? (
                    <CountPill>{store.notes.length}</CountPill>
                  ) : s.route === 'Tasks' ? (
                    <CountPill>{openTasks}</CountPill>
                  ) : undefined
                }
                showChevron={!editing}
                isLast={index === sections.length - 1}
                onPress={editing ? undefined : () => nav.navigate(s.route)}
              />
            )}
          />
        </Card>

        {/* The areas and their projects: what the areas tutorial points at. */}
        <TourAnchor id="home.areas">
        <SortableList
          items={areas}
          keyExtractor={(a) => a.id}
          enabled={editing}
          activateOnStart
          onDragActiveChange={setDragging}
          onReorder={(ids) => void reorderAreas(ids)}
          renderItem={({ item: area, drag }) => (
            <View>
              <SectionLabel
                // Editing reorders and deletes; otherwise the heading opens the area's page.
                onPress={editing ? undefined : () => nav.navigate('Area', { areaId: area.id })}
                leading={area.color ? <View style={[styles.areaDot, { backgroundColor: area.color }]} /> : undefined}
                trailing={
                  editing ? (
                    <>
                      {/* Areas are only deletable once empty (PLAN §6.6). */}
                      {area.empty ? (
                        <IconButton label={`Delete area ${area.name}`} onPress={() => setDeletingArea(area)}>
                          <Icon name="trash" size={16} color={colors.textTertiary} />
                        </IconButton>
                      ) : null}
                      <View {...drag} style={styles.dragHandle} aria-label={`Reorder ${area.name}`}>
                        <Icon name="moreH" size={18} color={colors.textTertiary} />
                      </View>
                    </>
                  ) : (
                    <IconButton
                      label={`New project in ${area.name}`}
                      onPress={() => {
                        setAddingProjectFor(area.id);
                        setProjectName('');
                      }}
                    >
                      <Icon name="plus" size={16} color={colors.textTertiary} />
                    </IconButton>
                  )
                }
              >
                {area.icon ? `${area.icon} ${area.name}` : area.name}
              </SectionLabel>
              {area.projects.length > 0 || (addingProjectFor === area.id && !editing) ? (
                <Card>
                  <SortableList
                    items={area.projects}
                    keyExtractor={(p) => p.id}
                    enabled={editing}
                    activateOnStart
                    onDragActiveChange={setDragging}
                    onReorder={(ids) => void reorderProjects(area.id, ids)}
                    renderItem={({ item: p, index, drag: pdrag }) => (
                      <ProjectRow
                        project={p}
                        counts={counts[p.id]}
                        isLast={index === area.projects.length - 1 && !(addingProjectFor === area.id && !editing)}
                        editing={editing}
                        drag={pdrag}
                        onPress={() => openProject(p.id)}
                      />
                    )}
                  />
                  {addingProjectFor === area.id && !editing ? (
                    <CreateInput placeholder="Name the project" value={projectName} onChangeText={setProjectName} onSubmit={() => void submitProject(area.id)} />
                  ) : null}
                </Card>
              ) : (
                <Text tone="tertiary" variant="caption" style={styles.areaEmpty}>
                  No projects yet.
                </Text>
              )}
            </View>
          )}
        />

        {sidebar.unsorted.length > 0 ? (
          <View>
            <SectionLabel>Unsorted</SectionLabel>
            <Card>
              {sidebar.unsorted.map((p, i) => (
                <ProjectRow key={p.id} project={p} counts={counts[p.id]} isLast={i === sidebar.unsorted.length - 1} onPress={() => openProject(p.id)} />
              ))}
            </Card>
          </View>
        ) : null}

        {sidebar.areas.length === 0 && sidebar.unsorted.length === 0 && !addingArea ? (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            Group your work into areas and projects. Start with a new area below.
          </Text>
        ) : null}
        </TourAnchor>

        {/* Settings and other secondary destinations live under the areas as a "More"
            card (moved off the header), along with the new-area affordance. */}
        <SectionLabel>More</SectionLabel>
        <Card>
          {editing ? null : addingArea ? (
            <CreateInput placeholder="Name the area" value={areaName} onChangeText={setAreaName} onSubmit={() => void submitArea()} divided />
          ) : (
            <CardRow
              leading={
                <IconTile variant="neutral">
                  <Icon name="plus" size={20} color={colors.textSecondary} />
                </IconTile>
              }
              title="New area"
              subtitle="A heading to group projects under"
              showChevron={false}
              onPress={() => setAddingArea(true)}
            />
          )}
          <CardRow
            leading={
              <IconTile variant="neutral">
                <Icon name="settings" size={20} color={colors.textSecondary} />
              </IconTile>
            }
            title="Settings"
            subtitle="Account, sync, appearance"
            isLast
            onPress={() => nav.navigate('Settings')}
          />
        </Card>
      </ScrollView>

      <Fab label="Quick capture" onPress={() => setCapture(true)} bottomInset={insets.bottom} />

      <CaptureSheet visible={capture} onClose={() => setCapture(false)} />

      {deletingArea ? (
        <ConfirmDialog
          title="Delete area?"
          message={`Delete the area “${deletingArea.name}”? It has no projects, so nothing else is affected.`}
          confirmLabel="Delete area"
          onConfirm={async () => {
            await deleteArea(deletingArea.id);
            setDeletingArea(null);
          }}
          onClose={() => setDeletingArea(null)}
        />
      ) : null}
    </View>
  );
}

/** Member counts per project, for the row subtitle and the done/total readout. The sidebar
 * tree only carries a completion ratio, so this reads each project's memberships (kept
 * fresh on the same `nav.changed` signal the scoped lists use) and resolves them against
 * the live note/task stores, which drops anything trashed. */
function useProjectCounts(sidebar: { areas: SidebarArea[]; unsorted: SidebarProject[] }): Record<string, ProjectCounts | undefined> {
  const { core } = useCore();
  const { membershipsForProject } = useProjects();
  const notes = useNotes().notes;
  const tasks = useTasks().tasks;
  const idsKey = [...sidebar.areas.flatMap((a) => a.projects), ...sidebar.unsorted].map((p) => p.id).join(',');
  const [members, setMembers] = useState<Record<string, { notes: string[]; tasks: string[] }>>({});

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          const rows = await membershipsForProject(id);
          return [
            id,
            {
              notes: rows.filter((m) => m.entityType === 'note').map((m) => m.entityId),
              tasks: rows.filter((m) => m.entityType === 'task').map((m) => m.entityId),
            },
          ] as const;
        }),
      );
      if (!cancelled) setMembers(Object.fromEntries(entries));
    };
    void load().catch(() => {});
    const off = core.on('nav.changed', () => void load().catch(() => {}));
    return () => {
      cancelled = true;
      off();
    };
  }, [idsKey, membershipsForProject, core]);

  return useMemo(() => {
    const noteIds = new Set(notes.map((n) => n.id));
    const taskStatus = new Map(tasks.map((t) => [t.id, t.status]));
    const out: Record<string, ProjectCounts | undefined> = {};
    for (const [id, m] of Object.entries(members)) {
      const live = m.tasks.filter((t) => taskStatus.has(t));
      out[id] = {
        notes: m.notes.filter((n) => noteIds.has(n)).length,
        tasks: live.length,
        done: live.filter((t) => taskStatus.get(t) === 'done').length,
      };
    }
    return out;
  }, [members, notes, tasks]);
}

function ProjectRow({
  project,
  counts,
  isLast,
  editing,
  drag,
  onPress,
}: {
  project: SidebarProject;
  counts?: ProjectCounts;
  isLast?: boolean;
  editing?: boolean;
  drag?: object;
  onPress: () => void;
}) {
  const progress = counts && counts.tasks > 0 ? counts.done / counts.tasks : project.taskProgress;
  return (
    <CardRow
      leading={
        <IconTile>
          {/* The project's own swatch tints the folder; without one it reads as any tile. */}
          <Icon name="folder" size={19} color={project.color ?? colors.textSecondary} />
        </IconTile>
      }
      title={project.name}
      subtitle={counts ? `${plural(counts.notes, 'note')} · ${plural(counts.tasks, 'task')}` : undefined}
      trailing={
        editing ? (
          // The handle is the drag surface (claims the gesture on touch-down so the
          // ScrollView can't steal it); the rest of the row is inert in edit mode.
          <View {...(drag ?? {})} style={styles.dragHandle} aria-label={`Reorder ${project.name}`}>
            <Icon name="moreH" size={18} color={colors.textTertiary} />
          </View>
        ) : progress != null ? (
          <View style={styles.progress}>
            <ProgressRing value={progress} size={16} />
            {counts && counts.tasks > 0 ? (
              <Text variant="mono" tone="quaternary">
                {counts.done}/{counts.tasks}
              </Text>
            ) : null}
          </View>
        ) : undefined
      }
      showChevron={!editing}
      isLast={isLast}
      onPress={editing ? undefined : onPress}
    />
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Quick-capture bottom sheet: the shared CaptureForm (note or task), mounted fresh each
 *  time it opens. Create-and-close. */
function CaptureSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {visible ? <CaptureForm onClose={onClose} /> : null}
    </BottomSheet>
  );
}

function CreateInput({
  placeholder,
  value,
  onChangeText,
  onSubmit,
  divided,
}: {
  placeholder: string;
  value: string;
  onChangeText: (t: string) => void;
  onSubmit: () => void;
  /** Close the field with the card's inset hairline (when more rows follow it). */
  divided?: boolean;
}) {
  return (
    <View style={[styles.createInput, divided ? styles.createInputDivided : null]}>
      <Input autoFocus placeholder={placeholder} value={value} onChangeText={onChangeText} onBlur={onSubmit} />
    </View>
  );
}

// "Thursday 17 September" — mono metadata, so it stays in normal case.
function dateLabel(): string {
  const d = new Date();
  const weekday = d.toLocaleDateString(undefined, { weekday: 'long' });
  const month = d.toLocaleDateString(undefined, { month: 'long' });
  return `${weekday} ${d.getDate()} ${month}`;
}

/** Header bell: opens the notifications feed, with a round danger count when there is
 *  anything unread (PLAN §6.4). */
function BellButton({ onPress }: { onPress: () => void }) {
  const { unreadCount } = useNotifications();
  return (
    <View>
      <IconButton label="Notifications" size="lg" onPress={onPress}>
        <Icon name="bell" size={18} color={colors.textSecondary} />
      </IconButton>
      {unreadCount > 0 ? (
        <View style={styles.bellBadge} pointerEvents="none">
          <Badge label={unreadCount > 9 ? '9+' : String(unreadCount)} tone="danger" round />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  // The large title stands in for a nav bar: no branding, no divider.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingLeft: space.lg + space.sm,
    paddingRight: space.lg,
    paddingBottom: space.ml,
  },
  greeting: {
    flex: 1,
    minWidth: 0,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: font.weight.semibold,
    letterSpacing: -0.55, // tracking-tight (-0.025em) at 22px
    color: colors.textPrimary,
  },
  date: { paddingHorizontal: space.sm, paddingBottom: space.ml },
  bellBadge: { position: 'absolute', top: -4, right: -4 },
  scroll: { paddingHorizontal: space.lg },
  areaDot: { width: 8, height: 8, borderRadius: radius.full, marginRight: space.xxs },
  // Generous hit area so the drag handle is easy to grab on touch.
  dragHandle: { paddingHorizontal: space.md, paddingVertical: space.sm },
  areaEmpty: { paddingHorizontal: space.sm, paddingBottom: space.xs },
  progress: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  createInput: { padding: space.lg },
  createInputDivided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  empty: { paddingHorizontal: space.sm, paddingTop: space.lg, lineHeight: 20 },
});
