import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SidebarArea, SidebarProject } from '@companion/core-bridge';
import { useNotes, useProjects, useTasks, useNotifications, useToolVisibility, SortableList, CaptureForm, ConfirmDialog, type ToolId } from '@companion/app';
import { Icon, IconButton, Input, ProgressRing, Text, colors, font, radius, space, type IconName } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { Card, CardRow, CountPill, IconTile, SectionLabel } from '../ui/native';

type Nav = NativeStackNavigationProp<RootStackParamList>;

type SectionRoute = 'Today' | 'Chat' | 'Notes' | 'Tasks' | 'Habits' | 'Calendar' | 'Graph' | 'Trash';
const SECTIONS: { route: SectionRoute; label: string; subtitle: string; icon: IconName; accent?: boolean }[] = [
  { route: 'Today', label: 'Today', subtitle: "Today's note and your month", icon: 'today' },
  { route: 'Chat', label: 'Chat', subtitle: 'Ask, capture, recall — anything', icon: 'chat', accent: true },
  { route: 'Notes', label: 'Notes', subtitle: 'Your graph of linked ideas', icon: 'notes' },
  { route: 'Tasks', label: 'Tasks', subtitle: 'What needs doing', icon: 'tasks' },
  { route: 'Habits', label: 'Habits', subtitle: 'Streaks and daily builders', icon: 'habits' },
  { route: 'Calendar', label: 'Calendar', subtitle: 'Events, tasks, and notes', icon: 'calendar' },
  { route: 'Graph', label: 'Graph', subtitle: 'See how everything connects', icon: 'graph' },
  { route: 'Trash', label: 'Trash', subtitle: 'Recently deleted, kept 30 days', icon: 'trash' },
];

/** The mobile root: a greeting header, a grouped card of global sections, then the
 * areas → projects tree as inset cards (PLAN §6.6). A quick-add FAB opens a capture
 * sheet. Opening a project pushes its scoped tab bar. */
export function HomeScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const store = useNotes();
  const { sidebar, createArea, createProject, deleteArea, reorderAreas, reorderProjects } = useProjects();

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

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <View style={{ flex: 1 }}>
          <Text variant="mono" style={styles.date}>
            {dateLabel()}
          </Text>
          <Text style={styles.greeting}>What's new today?</Text>
        </View>
        <BellButton onPress={() => nav.navigate('Notifications')} />
        <Pressable onPress={() => setEditing((v) => !v)} style={styles.editBtn} aria-label={editing ? 'Done reordering' : 'Edit'}>
          <Text variant="label" style={{ color: colors.accent, fontWeight: font.weight.semibold }}>
            {editing ? 'Done' : 'Edit'}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 96 }]}
        showsVerticalScrollIndicator={false}
        scrollEnabled={!dragging}
      >
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
                  ) : undefined
                }
                showChevron={!editing}
                isLast={index === sections.length - 1}
                onPress={editing ? undefined : () => nav.navigate(s.route)}
              />
            )}
          />
        </Card>

        <View style={styles.areasHeader}>
          <SectionLabel>Areas</SectionLabel>
          {editing ? null : (
            <IconButton label="New area" size="sm" onPress={() => setAddingArea((v) => !v)}>
              <Icon name="plus" size={16} color={colors.textTertiary} />
            </IconButton>
          )}
        </View>

        <SortableList
          items={sidebar.areas}
          keyExtractor={(a) => a.id}
          enabled={editing}
          activateOnStart
          onDragActiveChange={setDragging}
          onReorder={(ids) => void reorderAreas(ids)}
          renderItem={({ item: area, drag }) => (
            <View style={styles.area}>
              <View style={styles.areaTitleRow}>
                {area.color ? <View style={[styles.areaDot, { backgroundColor: area.color }]} /> : null}
                <Text variant="label" tone="secondary" numberOfLines={1} style={styles.areaTitle}>
                  {area.name}
                </Text>
                {editing ? (
                  <>
                    {/* Areas are only deletable once empty (PLAN §6.6). */}
                    {area.projects.length === 0 ? (
                      <IconButton label={`Delete area ${area.name}`} size="sm" onPress={() => setDeletingArea(area)}>
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
                    size="sm"
                    onPress={() => {
                      setAddingProjectFor(area.id);
                      setProjectName('');
                    }}
                  >
                    <Icon name="plus" size={14} color={colors.textTertiary} />
                  </IconButton>
                )}
              </View>
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
                        isLast={index === area.projects.length - 1 && !(addingProjectFor === area.id && !editing)}
                        editing={editing}
                        drag={pdrag}
                        onPress={() => openProject(p.id)}
                      />
                    )}
                  />
                  {addingProjectFor === area.id && !editing ? (
                    <CreateInput placeholder="Project name" value={projectName} onChangeText={setProjectName} onSubmit={() => void submitProject(area.id)} />
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
          <View style={styles.area}>
            <View style={styles.areaTitleRow}>
              <Text variant="label" tone="tertiary" style={styles.areaTitle}>
                Unsorted
              </Text>
            </View>
            <Card>
              {sidebar.unsorted.map((p, i) => (
                <ProjectRow key={p.id} project={p} isLast={i === sidebar.unsorted.length - 1} onPress={() => openProject(p.id)} />
              ))}
            </Card>
          </View>
        ) : null}

        {addingArea && !editing ? (
          <Card>
            <CreateInput placeholder="Area name" value={areaName} onChangeText={setAreaName} onSubmit={() => void submitArea()} />
          </Card>
        ) : null}

        {sidebar.areas.length === 0 && sidebar.unsorted.length === 0 && !addingArea ? (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            Group your work into areas and projects. Add one with ＋.
          </Text>
        ) : null}

        {/* Settings and other secondary destinations live under the areas as a "More"
            entry (moved off the header). */}
        <View style={styles.moreSection}>
          <SectionLabel>More</SectionLabel>
          <Card>
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
        </View>
      </ScrollView>

      <Pressable style={[styles.fab, { bottom: insets.bottom + space.xl }]} onPress={() => setCapture(true)} aria-label="Quick capture">
        <Icon name="plus" size={26} color={colors.textInverse} />
      </Pressable>

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

function ProjectRow({
  project,
  isLast,
  editing,
  drag,
  onPress,
}: {
  project: SidebarProject;
  isLast?: boolean;
  editing?: boolean;
  drag?: object;
  onPress: () => void;
}) {
  return (
    <CardRow
      leading={<View style={[styles.projectDot, { backgroundColor: project.color ?? colors.borderStrong }]} />}
      title={project.name}
      trailing={
        editing ? (
          // The handle is the drag surface (claims the gesture on touch-down so the
          // ScrollView can't steal it); the rest of the row is inert in edit mode.
          <View {...(drag ?? {})} style={styles.dragHandle} aria-label={`Reorder ${project.name}`}>
            <Icon name="moreH" size={18} color={colors.textTertiary} />
          </View>
        ) : project.taskProgress != null ? (
          <ProgressRing value={project.taskProgress} size={16} />
        ) : undefined
      }
      showChevron={!editing}
      isLast={isLast}
      separatorInset={space.xl + 10 + 14}
      onPress={editing ? undefined : onPress}
    />
  );
}

/** Quick-capture bottom sheet: the shared CaptureForm (note or task) in a bottom sheet,
 *  mounted fresh each time it opens. Create-and-close. */
function CaptureSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.xl }]}>
          <View style={styles.grabber} />
          {visible ? <CaptureForm onClose={onClose} /> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CreateInput({
  placeholder,
  value,
  onChangeText,
  onSubmit,
}: {
  placeholder: string;
  value: string;
  onChangeText: (t: string) => void;
  onSubmit: () => void;
}) {
  return (
    <View style={styles.createInput}>
      <Input size="sm" autoFocus placeholder={placeholder} value={value} onChangeText={onChangeText} onBlur={onSubmit} />
    </View>
  );
}

function dateLabel(): string {
  const d = new Date();
  const weekday = d.toLocaleDateString(undefined, { weekday: 'long' });
  const month = d.toLocaleDateString(undefined, { month: 'long' });
  return `${weekday} · ${month} ${d.getDate()}`.toUpperCase();
}

/** Header bell: opens the notifications feed, with an unread-count badge (PLAN §6.4). */
function BellButton({ onPress }: { onPress: () => void }) {
  const { unreadCount } = useNotifications();
  return (
    <Pressable onPress={onPress} style={styles.bellBtn} aria-label="Notifications">
      <Icon name="bell" size={20} color={colors.textSecondary} />
      {unreadCount > 0 ? (
        <View style={styles.bellBadge} pointerEvents="none">
          <Text style={styles.bellBadgeLabel}>{unreadCount > 9 ? '9+' : String(unreadCount)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingBottom: space.lg,
  },
  date: { fontSize: 11, letterSpacing: 0.9, color: colors.textTertiary, marginBottom: space.xs },
  greeting: { fontSize: 26, fontWeight: font.weight.semibold, letterSpacing: -0.5, color: colors.textPrimary },
  editBtn: {
    minHeight: 40,
    paddingHorizontal: space.md,
    justifyContent: 'center',
  },
  bellBtn: {
    minHeight: 40,
    paddingHorizontal: space.sm,
    justifyContent: 'center',
  },
  bellBadge: {
    position: 'absolute',
    top: 6,
    right: 0,
    minWidth: 15,
    height: 15,
    paddingHorizontal: 3,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadgeLabel: { color: colors.onAccent, fontSize: 9, lineHeight: 11, fontWeight: font.weight.bold },
  scroll: { paddingHorizontal: space.xl, paddingTop: space.xs },
  areasHeader: { flexDirection: 'row', alignItems: 'center', marginTop: space.xl },
  moreSection: { marginTop: space.lg },
  area: { marginBottom: space.sm },
  areaTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, height: 34 },
  areaDot: { width: 8, height: 8, borderRadius: radius.full },
  areaTitle: { flex: 1, fontWeight: font.weight.semibold },
  // Generous hit area so the drag handle is easy to grab on touch.
  dragHandle: { paddingHorizontal: space.md, paddingVertical: space.sm },
  areaEmpty: { paddingHorizontal: space.md, paddingBottom: space.sm },
  projectDot: { width: 10, height: 10, borderRadius: radius.full, flexShrink: 0 },
  createInput: { padding: space.md },
  empty: { paddingHorizontal: space.md, paddingVertical: space.lg, lineHeight: 20 },
  fab: {
    position: 'absolute',
    right: space.xl,
    width: 58,
    height: 58,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  scrim: { flex: 1, backgroundColor: 'rgba(17,17,16,0.35)' },
  sheet: {
    backgroundColor: colors.surfaceCard,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: space.xl,
  },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderDefault, alignSelf: 'center', marginBottom: space.lg },
});
