import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SidebarProject } from '@companion/core-bridge';
import { useNotes, useProjects, useTasks, useCore, SortableList } from '@companion/app';
import { Icon, IconButton, Input, ProgressRing, Text, colors, font, radius, space, type IconName } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { Card, CardRow, CountPill, IconTile, SectionLabel } from '../ui/native';

type Nav = NativeStackNavigationProp<RootStackParamList>;

type SectionRoute = 'Chat' | 'Notes' | 'Tasks' | 'Habits' | 'Calendar' | 'Graph' | 'Trash';
const SECTIONS: { route: SectionRoute; label: string; subtitle: string; icon: IconName; accent?: boolean }[] = [
  { route: 'Chat', label: 'Chat', subtitle: 'Ask, capture, recall — anything', icon: 'chat', accent: true },
  { route: 'Notes', label: 'Notes', subtitle: 'Your graph of linked ideas', icon: 'notes' },
  { route: 'Tasks', label: 'Tasks', subtitle: 'What needs doing', icon: 'tasks' },
  { route: 'Habits', label: 'Habits', subtitle: 'Streaks and daily builders', icon: 'habits' },
  { route: 'Calendar', label: 'Calendar', subtitle: 'Events and habit streaks', icon: 'calendar' },
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
  const { sidebar, createArea, createProject, reorderAreas, reorderProjects } = useProjects();

  const [addingArea, setAddingArea] = useState(false);
  const [areaName, setAreaName] = useState('');
  const [addingProjectFor, setAddingProjectFor] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [capture, setCapture] = useState(false);
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

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <View style={{ flex: 1 }}>
          <Text variant="mono" style={styles.date}>
            {dateLabel()}
          </Text>
          <Text style={styles.greeting}>What's new today?</Text>
        </View>
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
          {SECTIONS.map((s, i) => (
            <CardRow
              key={s.route}
              leading={
                <IconTile variant={s.accent ? 'accent' : 'neutral'}>
                  <Icon name={s.icon} size={20} color={s.accent ? colors.accent : colors.textSecondary} />
                </IconTile>
              }
              title={s.label}
              subtitle={s.subtitle}
              trailing={s.route === 'Notes' ? <CountPill>{store.notes.length}</CountPill> : undefined}
              isLast={i === SECTIONS.length - 1}
              onPress={() => nav.navigate(s.route)}
            />
          ))}
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
                  <View {...drag} style={styles.dragHandle} aria-label={`Reorder ${area.name}`}>
                    <Icon name="moreH" size={18} color={colors.textTertiary} />
                  </View>
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

type CaptureKind = 'note' | 'task';

/** Quick-capture bottom sheet, redesigned as a two-question form (a note or a task).
 *  Q1 is a pill toggle; Q2 is the entry form for the chosen kind. Notes are a plain-text
 *  quick entry (no ProseMirror); tasks capture a title plus natural-language due / reminder
 *  fields (parsed in core via dates.parse). Both create-and-close — quick capture shouldn't
 *  yank you into an editor. */
function CaptureSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const notes = useNotes();
  const tasks = useTasks();
  const { dates } = useCore();

  const [kind, setKind] = useState<CaptureKind>('note');
  const [noteDraft, setNoteDraft] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [due, setDue] = useState('');
  const [dueResolved, setDueResolved] = useState<string | null>(null);
  const [dueFailed, setDueFailed] = useState(false);
  const [remind, setRemind] = useState('');
  const [remindResolved, setRemindResolved] = useState<string | null>(null);
  const [remindFailed, setRemindFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Fresh form every time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setKind('note');
    setNoteDraft('');
    setTaskTitle('');
    setDue('');
    setDueResolved(null);
    setDueFailed(false);
    setRemind('');
    setRemindResolved(null);
    setRemindFailed(false);
    setBusy(false);
  }, [visible]);

  // Parse a NL field; returns the ISO timestamp, `null` when empty, or 'invalid' when the
  // text couldn't be understood. Shared by the live preview and the final submit.
  const parseNl = async (text: string): Promise<string | null | 'invalid'> => {
    const t = text.trim();
    if (!t) return null;
    const parsed = await dates.parse(t);
    return parsed ? parsed.at : 'invalid';
  };

  const previewDue = async () => {
    const r = await parseNl(due);
    setDueFailed(r === 'invalid');
    setDueResolved(typeof r === 'string' && r !== 'invalid' ? formatResolved(r) : null);
  };
  const previewRemind = async () => {
    const r = await parseNl(remind);
    setRemindFailed(r === 'invalid');
    setRemindResolved(typeof r === 'string' && r !== 'invalid' ? formatResolved(r) : null);
  };

  const saveNote = async () => {
    const text = noteDraft.trim();
    if (!text || busy) return;
    setBusy(true);
    const title = text.split('\n')[0].slice(0, 60);
    await notes.create({ title, contentMd: text });
    onClose();
  };

  const saveTask = async () => {
    const title = taskTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    const dueAt = await parseNl(due);
    if (dueAt === 'invalid') {
      setDueFailed(true);
      setBusy(false);
      return;
    }
    const remindAt = await parseNl(remind);
    if (remindAt === 'invalid') {
      setRemindFailed(true);
      setBusy(false);
      return;
    }
    await tasks.create({ title, dueAt: dueAt ?? undefined, remindAt: remindAt ?? undefined });
    onClose();
  };

  const canSubmit = kind === 'note' ? noteDraft.trim().length > 0 : taskTitle.trim().length > 0;
  const submit = kind === 'note' ? saveNote : saveTask;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.xl }]}>
          <View style={styles.grabber} />

          {/* Q1: note or task */}
          <View style={styles.segment}>
            {(['note', 'task'] as const).map((k) => (
              <Pressable
                key={k}
                onPress={() => setKind(k)}
                style={[styles.segmentBtn, kind === k ? styles.segmentBtnActive : null]}
                aria-label={k === 'note' ? 'Capture a note' : 'Capture a task'}
              >
                <Icon name={k === 'note' ? 'notes' : 'tasks'} size={15} color={kind === k ? colors.textInverse : colors.textSecondary} />
                <Text
                  variant="label"
                  style={{ color: kind === k ? colors.textInverse : colors.textSecondary, fontWeight: font.weight.semibold }}
                >
                  {k === 'note' ? 'Note' : 'Task'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Q2: the form for that kind */}
          {kind === 'note' ? (
            <TextInput
              value={noteDraft}
              onChangeText={setNoteDraft}
              placeholder="Type anything. Use [[ to link a note."
              placeholderTextColor={colors.textTertiary}
              multiline
              autoFocus
              style={styles.sheetInput}
            />
          ) : (
            <View style={{ gap: space.lg }}>
              <Field label="What do you need to do?">
                <TextInput
                  value={taskTitle}
                  onChangeText={setTaskTitle}
                  placeholder="e.g. Email the design draft"
                  placeholderTextColor={colors.textTertiary}
                  autoFocus
                  style={styles.taskTitleInput}
                />
              </Field>
              <Field label="When is this due?" hint={dueResolved} error={dueFailed ? "Couldn't read a date — try “next friday”." : null}>
                <Input
                  size="sm"
                  value={due}
                  onChangeText={(t) => {
                    setDue(t);
                    setDueFailed(false);
                  }}
                  onSubmitEditing={() => void previewDue()}
                  onBlur={() => void previewDue()}
                  placeholder="Natural language, e.g. tomorrow"
                  leadingIcon={<Icon name="calendar" size={14} color={colors.textTertiary} />}
                />
              </Field>
              <Field
                label="Do you want me to remind you?"
                hint={remindResolved}
                error={remindFailed ? "Couldn't read a time — try “tomorrow 9am”." : null}
              >
                <Input
                  size="sm"
                  value={remind}
                  onChangeText={(t) => {
                    setRemind(t);
                    setRemindFailed(false);
                  }}
                  onSubmitEditing={() => void previewRemind()}
                  onBlur={() => void previewRemind()}
                  placeholder="Natural language, e.g. in 2 hours"
                  leadingIcon={<Icon name="calendar" size={14} color={colors.textTertiary} />}
                />
              </Field>
            </View>
          )}

          <View style={styles.sheetActions}>
            <Pressable style={[styles.sheetBtn, styles.sheetBtnGhost]} onPress={onClose}>
              <Text variant="label" tone="secondary">
                Cancel
              </Text>
            </Pressable>
            <Pressable
              style={[styles.sheetBtn, styles.sheetBtnPrimary, !canSubmit || busy ? styles.sheetBtnDisabled : null]}
              onPress={() => void submit()}
              disabled={!canSubmit || busy}
            >
              <Text variant="label" style={{ color: colors.textInverse, fontWeight: font.weight.semibold }}>
                {kind === 'note' ? 'Save note' : 'Save task'}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A labelled form field for the task capture form, with an optional resolved-date hint
 *  (green confirmation of what a NL phrase parsed to) or an error line. */
function Field({ label, hint, error, children }: { label: string; hint?: string | null; error?: string | null; children: ReactNode }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="label" tone="secondary" style={{ fontWeight: font.weight.medium }}>
        {label}
      </Text>
      {children}
      {error ? (
        <Text variant="caption" tone="accent">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" style={{ color: colors.success }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** Format a parsed ISO timestamp as a short confirmation, e.g. "Fri, Jul 10 · 5:00 PM". */
function formatResolved(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
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
  segment: {
    flexDirection: 'row',
    gap: space.xs,
    padding: 3,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSunken,
    marginBottom: space.lg,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    height: 38,
    borderRadius: radius.full,
  },
  segmentBtnActive: { backgroundColor: colors.accent },
  taskTitleInput: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    height: 46,
    fontSize: 15,
    fontFamily: font.sans,
    color: colors.textPrimary,
  },
  sheetInput: {
    minHeight: 96,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.lg,
    padding: space.lg,
    fontSize: 15,
    fontFamily: font.sans,
    lineHeight: 22,
    color: colors.textPrimary,
    textAlignVertical: 'top',
  },
  sheetActions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  sheetBtn: { flex: 1, height: 46, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  sheetBtnGhost: { borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.surfaceCard },
  sheetBtnPrimary: { backgroundColor: colors.accent },
  sheetBtnDisabled: { opacity: 0.4 },
});
