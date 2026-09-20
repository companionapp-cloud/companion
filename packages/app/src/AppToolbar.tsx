import { ScrollView, View } from "react-native";
import {
  Avatar,
  Button,
  Divider,
  Icon,
  IconButton,
  Tab,
  Toolbar,
  colors,
  icon,
  layout,
  motion,
  space,
  themeSwitchable,
  toggleTheme,
  transition,
  useTheme,
  type IconName,
} from "@companion/design-system";
import { docOfRef, useNav, type DocRef, type SurfaceViewId, type TabRef, type WorkspaceSection } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useProjects } from "./ProjectsProvider";
import { useSync } from "./SyncProvider";
import { useCanvases } from "./canvas/CanvasesProvider";
import { NotificationsBell } from "./NotificationsBell";
import { Draggable } from "./DndContext";

const VIEW_META: Record<SurfaceViewId, { label: string; icon: IconName }> = {
  today: { label: "Today", icon: "today" },
  chat: { label: "Chat", icon: "chat" },
  calendar: { label: "Calendar", icon: "calendar" },
  habits: { label: "Habits", icon: "habits" },
  graph: { label: "Graph", icon: "graph" },
  logbook: { label: "Logbook", icon: "logbook" },
  trash: { label: "Trash", icon: "trash" },
  settings: { label: "Settings", icon: "settings" },
  notifications: { label: "Notifications", icon: "bell" },
};

const SECTION_META: Record<WorkspaceSection, { label: string; icon: IconName }> = {
  notes: { label: "Notes", icon: "notes" },
  tasks: { label: "Tasks", icon: "tasks" },
  canvases: { label: "Canvases", icon: "canvas" },
};

const DOC_ICON: Record<DocRef["kind"], IconName> = { note: "file", task: "tasks", canvas: "canvas" };

/** The app's top toolbar: the active tab's back/forward history, the tab strip — every
 * open surface, document or view — a "+" for an empty tab, then quick capture, the theme
 * toggle, notifications and the signed-in account. `leftInset` is extra leading space
 * kept clear for native window controls (the macOS traffic lights) that overhang the
 * rail; it animates with the rail's width so the strip doesn't jump. */
export function AppToolbar({
  onCapture,
  leftInset = 0,
  verticalInset = 0,
}: {
  onCapture: () => void;
  /** Leading room kept clear of native window controls overhanging the rail. */
  leftInset?: number;
  /** Padding above and below the row, so it sits level with those controls and the
   *  content beneath gets the same breathing room. */
  verticalInset?: number;
}) {
  const nav = useNav();
  const notes = useNotes();
  const tasks = useTasks();
  const canvases = useCanvases();
  const { projectById, areas } = useProjects();
  const sync = useSync();
  const theme = useTheme();

  const docLabel = (doc: DocRef) => {
    const title =
      doc.kind === "note" ? notes.byId(doc.id)?.title : doc.kind === "task" ? (tasks.byId(doc.id) ?? tasks.seedById(doc.id))?.title : canvases.byId(doc.id)?.name;
    return title || (doc.kind === "canvas" ? "Untitled canvas" : "Untitled");
  };

  const describe = (ref: TabRef | null): { label: string; icon?: IconName } => {
    if (!ref) return { label: "Nothing selected" };
    const doc = docOfRef(ref);
    if (doc) return { label: docLabel(doc), icon: DOC_ICON[doc.kind] };
    if (ref.kind === "browse") return SECTION_META[ref.section];
    if (ref.kind === "view") return VIEW_META[ref.view];
    if (ref.kind === "project") return { label: projectById(ref.projectId)?.name || "Project", icon: "folder" };
    if (ref.kind === "area") return { label: areas.find((a) => a.id === ref.areaId)?.name || "Area", icon: "folder" };
    return { label: "Untitled" };
  };

  return (
    <Toolbar style={verticalInset > 0 ? { height: layout.toolbarH + verticalInset * 2, paddingVertical: verticalInset } : undefined}>
      {leftInset > 0 ? <View style={[{ width: leftInset, marginLeft: -space.sm }, transition("width", motion.medium)]} /> : null}
      <IconButton label="Back" size="sm" disabled={!nav.canBack} onPress={nav.back}>
        <Icon name="chevronLeft" size={icon.md} color={colors.textSecondary} />
      </IconButton>
      <IconButton label="Forward" size="sm" disabled={!nav.canForward} onPress={nav.forward}>
        <Icon name="chevronRight" size={icon.md} color={colors.textSecondary} />
      </IconButton>

      <Divider vertical style={separator} />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", gap: 3 }}
      >
        {nav.tabs.map((tab, i) => {
          const { label, icon: glyph } = describe(tab.ref);
          const doc = docOfRef(tab.ref);
          const el = (
            <Tab
              label={label}
              active={i === nav.activeIndex}
              icon={glyph ? <Icon name={glyph} size={11} color={colors.textQuaternary} /> : undefined}
              onPress={() => nav.selectTab(i)}
              // Only notes and tasks have a focus window to pop out into.
              onExpand={doc && doc.kind !== "canvas" ? () => nav.expandTab(i) : undefined}
              onClose={() => nav.closeTab(i)}
            />
          );
          // A tab holding a document can be dragged onto a project or area to move it there
          // (a note/task also onto a board, to add it as a card).
          return doc ? (
            <Draggable key={tab.uid} payload={{ kind: doc.kind, id: doc.id, label }}>
              {el}
            </Draggable>
          ) : (
            <View key={tab.uid}>{el}</View>
          );
        })}
        <IconButton label="New tab" size="sm" onPress={nav.addTab}>
          <Icon name="plus" size={icon.sm} color={colors.textTertiary} />
        </IconButton>
        {/* Fills the remaining toolbar width (also a desktop window drag handle). */}
        <View style={{ flex: 1, alignSelf: "stretch" }} />
      </ScrollView>

      <Button
        label="Capture"
        size="sm"
        variant="ghost"
        kbd="⌥⇧␣"
        icon={<Icon name="capture" size={13} color={colors.textSecondary} />}
        onPress={onCapture}
      />
      {themeSwitchable ? (
        <IconButton label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} size="sm" onPress={toggleTheme}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={icon.md} color={colors.textSecondary} />
        </IconButton>
      ) : null}
      <NotificationsBell />
      {sync.email ? <Avatar name={sync.email} size="sm" /> : null}
    </Toolbar>
  );
}

const separator = { height: 14, alignSelf: "center" as const, marginHorizontal: space.xxs + 1 };
