import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { SidebarArea, SidebarProject } from "@companion/core-bridge";
import { Icon, IconButton, Input, ProgressRing, Text, colors, font, radius, space, type IconName } from "@companion/design-system";
import { useNav, type ViewId } from "../nav-context";
import { useNotes } from "../NotesProvider";
import { useProjects } from "../ProjectsProvider";
import { useNotifications } from "../NotificationsProvider";
import { useToolVisibility, type ToolId } from "../ToolVisibilityProvider";
import { CaptureForm } from "../CaptureForm";
import { ConfirmDialog } from "../ConfirmDialog";
import { Card, CardRow, CountPill, IconTile, SectionLabel } from "./ui";

// The mobile web root — a port of the native app's HomeScreen (apps/mobile): a greeting
// header, a grouped card of global sections, then the areas → projects tree as inset
// cards. A quick-add FAB opens a capture sheet. (Reorder/edit mode stays native-only for
// now; section order still follows Settings › Tools.)

type SectionView = Extract<ViewId, "today" | "chat" | "notes" | "tasks" | "habits" | "calendar" | "graph" | "trash">;
const SECTIONS: { view: SectionView; label: string; subtitle: string; icon: IconName; accent?: boolean }[] = [
  { view: "today", label: "Today", subtitle: "Today's note and your month", icon: "today" },
  { view: "chat", label: "Chat", subtitle: "Ask, capture, recall — anything", icon: "chat", accent: true },
  { view: "notes", label: "Notes", subtitle: "Your graph of linked ideas", icon: "notes" },
  { view: "tasks", label: "Tasks", subtitle: "What needs doing", icon: "tasks" },
  { view: "habits", label: "Habits", subtitle: "Streaks and daily builders", icon: "habits" },
  { view: "calendar", label: "Calendar", subtitle: "Events, tasks, and notes", icon: "calendar" },
  { view: "graph", label: "Graph", subtitle: "See how everything connects", icon: "graph" },
  { view: "trash", label: "Trash", subtitle: "Recently deleted, kept 30 days", icon: "trash" },
];

export function HomeScreen() {
  const nav = useNav();
  const store = useNotes();
  const { sidebar, createArea, createProject, deleteArea } = useProjects();

  const [addingArea, setAddingArea] = useState(false);
  const [areaName, setAreaName] = useState("");
  const [addingProjectFor, setAddingProjectFor] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [capture, setCapture] = useState(false);
  // The empty area pending deletion (its confirm dialog renders over the screen).
  const [deletingArea, setDeletingArea] = useState<SidebarArea | null>(null);

  const submitArea = async () => {
    const name = areaName.trim();
    setAreaName("");
    setAddingArea(false);
    if (name) await createArea({ name });
  };
  const submitProject = async (areaId: string) => {
    const name = projectName.trim();
    setProjectName("");
    setAddingProjectFor(null);
    if (name) await createProject({ areaId, name });
  };

  // Per-device tool hiding + ordering (Settings › Tools): the home sections card is
  // mobile's sidebar-equivalent, so hidden tools drop out and rows follow the saved order.
  const { tools, hidden } = useToolVisibility();
  const orderIndex = new Map(tools.map((t, i) => [t.id, i]));
  const sections = SECTIONS.filter((s) => !hidden.has(s.view as ToolId)).sort(
    (a, b) => (orderIndex.get(a.view as ToolId) ?? 0) - (orderIndex.get(b.view as ToolId) ?? 0),
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text variant="mono" style={styles.date}>
            {dateLabel()}
          </Text>
          <Text style={styles.greeting}>What's new today?</Text>
        </View>
        <BellButton onPress={() => nav.goView("notifications")} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card>
          {sections.map((s, index) => (
            <CardRow
              key={s.view}
              leading={
                <IconTile variant={s.accent ? "accent" : "neutral"}>
                  <Icon name={s.icon} size={20} color={s.accent ? colors.accent : colors.textSecondary} />
                </IconTile>
              }
              title={s.label}
              subtitle={s.subtitle}
              trailing={s.view === "notes" ? <CountPill>{store.notes.length}</CountPill> : undefined}
              isLast={index === sections.length - 1}
              onPress={() => nav.goView(s.view)}
            />
          ))}
        </Card>

        <View style={styles.areasHeader}>
          <SectionLabel>Areas</SectionLabel>
          <View style={{ flex: 1 }} />
          <IconButton label="New area" size="sm" onPress={() => setAddingArea((v) => !v)}>
            <Icon name="plus" size={16} color={colors.textTertiary} />
          </IconButton>
        </View>

        {sidebar.areas.map((area) => (
          <View key={area.id} style={styles.area}>
            <View style={styles.areaTitleRow}>
              {area.color ? <View style={[styles.areaDot, { backgroundColor: area.color }]} /> : null}
              <Text variant="label" tone="secondary" numberOfLines={1} style={styles.areaTitle}>
                {area.name}
              </Text>
              {/* Areas are only deletable once empty (PLAN §6.6). */}
              {area.projects.length === 0 ? (
                <IconButton label={`Delete area ${area.name}`} size="sm" onPress={() => setDeletingArea(area)}>
                  <Icon name="trash" size={14} color={colors.textTertiary} />
                </IconButton>
              ) : null}
              <IconButton
                label={`New project in ${area.name}`}
                size="sm"
                onPress={() => {
                  setAddingProjectFor(area.id);
                  setProjectName("");
                }}
              >
                <Icon name="plus" size={14} color={colors.textTertiary} />
              </IconButton>
            </View>
            {area.projects.length > 0 || addingProjectFor === area.id ? (
              <Card>
                {area.projects.map((p, i) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    isLast={i === area.projects.length - 1 && addingProjectFor !== area.id}
                    onPress={() => nav.openProject(p.id)}
                  />
                ))}
                {addingProjectFor === area.id ? (
                  <CreateInput placeholder="Project name" value={projectName} onChangeText={setProjectName} onSubmit={() => void submitProject(area.id)} />
                ) : null}
              </Card>
            ) : (
              <Text tone="tertiary" variant="caption" style={styles.areaEmpty}>
                No projects yet.
              </Text>
            )}
          </View>
        ))}

        {sidebar.unsorted.length > 0 ? (
          <View style={styles.area}>
            <View style={styles.areaTitleRow}>
              <Text variant="label" tone="tertiary" style={styles.areaTitle}>
                Unsorted
              </Text>
            </View>
            <Card>
              {sidebar.unsorted.map((p, i) => (
                <ProjectRow key={p.id} project={p} isLast={i === sidebar.unsorted.length - 1} onPress={() => nav.openProject(p.id)} />
              ))}
            </Card>
          </View>
        ) : null}

        {addingArea ? (
          <Card>
            <CreateInput placeholder="Area name" value={areaName} onChangeText={setAreaName} onSubmit={() => void submitArea()} />
          </Card>
        ) : null}

        {sidebar.areas.length === 0 && sidebar.unsorted.length === 0 && !addingArea ? (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            Group your work into areas and projects. Add one with ＋.
          </Text>
        ) : null}

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
              onPress={() => nav.goView("settings")}
            />
          </Card>
        </View>
      </ScrollView>

      <Pressable style={styles.fab} onPress={() => setCapture(true)} aria-label="Quick capture">
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

function ProjectRow({ project, isLast, onPress }: { project: SidebarProject; isLast?: boolean; onPress: () => void }) {
  return (
    <CardRow
      leading={<View style={[styles.projectDot, { backgroundColor: project.color ?? colors.borderStrong }]} />}
      title={project.name}
      trailing={project.taskProgress != null ? <ProgressRing value={project.taskProgress} size={16} /> : undefined}
      isLast={isLast}
      separatorInset={space.xl + 10 + 14}
      onPress={onPress}
    />
  );
}

/** Quick-capture bottom sheet: the shared CaptureForm (note or task) in a bottom sheet,
 *  mounted fresh each time it opens. Create-and-close. */
function CaptureSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        {visible ? <CaptureForm onClose={onClose} /> : null}
      </View>
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
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const month = d.toLocaleDateString(undefined, { month: "long" });
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
          <Text style={styles.bellBadgeLabel}>{unreadCount > 9 ? "9+" : String(unreadCount)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
    paddingBottom: space.lg,
  },
  date: { fontSize: 11, letterSpacing: 0.9, color: colors.textTertiary, marginBottom: space.xs },
  greeting: { fontSize: 26, fontWeight: font.weight.semibold, letterSpacing: -0.5, color: colors.textPrimary },
  bellBtn: {
    minHeight: 40,
    paddingHorizontal: space.sm,
    justifyContent: "center",
  },
  bellBadge: {
    position: "absolute",
    top: 6,
    right: 0,
    minWidth: 15,
    height: 15,
    paddingHorizontal: 3,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  bellBadgeLabel: { color: colors.onAccent, fontSize: 9, lineHeight: 11, fontWeight: font.weight.bold },
  scroll: { paddingHorizontal: space.xl, paddingTop: space.xs, paddingBottom: 96 },
  areasHeader: { flexDirection: "row", alignItems: "center", marginTop: space.xl },
  moreSection: { marginTop: space.lg },
  area: { marginBottom: space.sm },
  areaTitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, height: 34 },
  areaDot: { width: 8, height: 8, borderRadius: radius.full },
  areaTitle: { flexShrink: 1, fontWeight: font.weight.semibold },
  areaEmpty: { paddingHorizontal: space.md, paddingBottom: space.sm },
  projectDot: { width: 10, height: 10, borderRadius: radius.full, flexShrink: 0 },
  createInput: { padding: space.md },
  empty: { paddingHorizontal: space.md, paddingVertical: space.lg, lineHeight: 20 },
  fab: {
    position: "absolute",
    right: space.xl,
    bottom: space.xl,
    width: 58,
    height: 58,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.accent,
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  scrim: { flex: 1, backgroundColor: "rgba(17,17,16,0.35)" },
  sheet: {
    backgroundColor: colors.surfaceCard,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: space.xl,
  },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderDefault, alignSelf: "center", marginBottom: space.lg },
});
