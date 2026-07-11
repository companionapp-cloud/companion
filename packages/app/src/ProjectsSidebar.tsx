import { useState } from "react";
import { Pressable, View } from "react-native";
import type { SidebarArea, SidebarProject } from "@companion/core-bridge";
import { Icon, IconButton, Input, ProgressRing, Text, colors, radius, space, type PressState } from "@companion/design-system";
import { useProjects } from "./ProjectsProvider";
import { SortableList } from "./SortableList";
import { useDropTarget } from "./DndContext";

/** The areas → projects tree in the expanded rail (PLAN §6.6): area headings, project
 * nav items with a task-completion ring (hidden until member tasks exist), an
 * "Unsorted" bucket for dangling areas, and inline create affordances. Areas and the
 * projects within each area are drag-reorderable (drag a row; a tap still navigates). */
export function ProjectsSidebar({
  onSelectProject,
  activeProjectId,
  onDeleteArea,
}: {
  onSelectProject?: (id: string) => void;
  activeProjectId?: string | null;
  /** Request deletion of an (empty) area. The host renders the confirm dialog outside the
   *  clipped rail (see AppShell). */
  onDeleteArea?: (area: SidebarArea) => void;
}) {
  const { sidebar, createArea, createProject, reorderAreas, reorderProjects } = useProjects();
  const [addingArea, setAddingArea] = useState(false);
  const [areaName, setAreaName] = useState("");
  // Which area's "new project" input is open (areaId), plus its text.
  const [addingProjectFor, setAddingProjectFor] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");

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

  const isEmpty = sidebar.areas.length === 0 && sidebar.unsorted.length === 0;

  const renderArea = (area: SidebarArea, dragHandlers: object) => (
    <View style={{ marginBottom: space.sm }}>
      <AreaHeader
        area={area}
        dragHandlers={dragHandlers}
        onAddProject={() => {
          setAddingProjectFor(area.id);
          setProjectName("");
        }}
        onDeleteArea={onDeleteArea}
      />
      <SortableList
        items={area.projects}
        keyExtractor={(p) => p.id}
        onReorder={(ids) => void reorderProjects(area.id, ids)}
        renderItem={({ item: p, isActive, drag }) => (
          <View {...drag}>
            <ProjectRow project={p} active={p.id === activeProjectId} dragging={isActive} onPress={() => onSelectProject?.(p.id)} />
          </View>
        )}
      />
      {addingProjectFor === area.id ? (
        <CreateInput
          placeholder="Project name"
          value={projectName}
          onChangeText={setProjectName}
          onSubmit={() => void submitProject(area.id)}
          onCancel={() => setAddingProjectFor(null)}
        />
      ) : null}
    </View>
  );

  return (
    <View style={{ gap: 2 }}>
      <View style={styles.sectionHeader}>
        <Text variant="caption" tone="tertiary" style={{ flex: 1, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 }}>
          Projects
        </Text>
        <IconButton label="New area" size="sm" onPress={() => setAddingArea((v) => !v)}>
          <Icon name="plus" size={15} color={colors.textTertiary} />
        </IconButton>
      </View>

      <SortableList
        items={sidebar.areas}
        keyExtractor={(a) => a.id}
        onReorder={(ids) => void reorderAreas(ids)}
        renderItem={({ item: area, drag }) => renderArea(area, drag)}
      />

      {sidebar.unsorted.length > 0 ? (
        <View style={{ marginBottom: space.sm }}>
          <View style={styles.areaHeader}>
            <Text variant="caption" tone="tertiary" numberOfLines={1} style={{ flex: 1, fontWeight: "600" }}>
              Unsorted
            </Text>
          </View>
          {sidebar.unsorted.map((p) => (
            <ProjectRow key={p.id} project={p} active={p.id === activeProjectId} onPress={() => onSelectProject?.(p.id)} />
          ))}
        </View>
      ) : null}

      {addingArea ? (
        <CreateInput
          placeholder="Area name"
          value={areaName}
          onChangeText={setAreaName}
          onSubmit={() => void submitArea()}
          onCancel={() => setAddingArea(false)}
        />
      ) : null}

      {isEmpty && !addingArea ? (
        <Text tone="tertiary" variant="caption" style={{ paddingHorizontal: space.sm, paddingVertical: space.sm, lineHeight: 18 }}>
          Group your work into areas and projects. Add one with ＋.
        </Text>
      ) : null}
    </View>
  );
}

/** An area heading: a color dot, name, and the always-present "new project" button. An
 *  empty area additionally reveals a delete button on hover — areas are only deletable once
 *  they hold no projects (PLAN §6.6). */
function AreaHeader({
  area,
  dragHandlers,
  onAddProject,
  onDeleteArea,
}: {
  area: SidebarArea;
  dragHandlers: object;
  onAddProject: () => void;
  onDeleteArea?: (area: SidebarArea) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const deletable = area.projects.length === 0 && !!onDeleteArea;
  return (
    <View
      style={styles.areaHeader}
      {...dragHandlers}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {area.color ? <View style={[styles.areaDot, { backgroundColor: area.color }]} /> : null}
      <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1, fontWeight: "600" }}>
        {area.name}
      </Text>
      {deletable && hovered ? (
        <IconButton label={`Delete area ${area.name}`} size="sm" onPress={() => onDeleteArea?.(area)}>
          <Icon name="trash" size={13} color={colors.textTertiary} />
        </IconButton>
      ) : null}
      <IconButton label={`New project in ${area.name}`} size="sm" onPress={onAddProject}>
        <Icon name="plus" size={13} color={colors.textTertiary} />
      </IconButton>
    </View>
  );
}

function ProjectRow({
  project,
  active,
  dragging,
  onPress,
}: {
  project: SidebarProject;
  active?: boolean;
  dragging?: boolean;
  onPress?: () => void;
}) {
  const { addMember } = useProjects();
  // A project is a drop target: dropping a dragged note/task adds it to this project.
  const { ref, isOver } = useDropTarget(project.id, (p) => void addMember(project.id, p.kind, p.id));
  return (
    <View ref={ref}>
      <Pressable
        onPress={onPress}
        style={({ hovered }: PressState) => [
          styles.projectRow,
          {
            backgroundColor: isOver || active ? colors.accentSoft : dragging ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent",
            borderColor: isOver ? colors.accent : "transparent",
          },
        ]}
      >
        <View style={[styles.projectDot, { backgroundColor: project.color ?? colors.borderStrong }]} />
        <Text variant="label" tone={active || isOver ? "accent" : "secondary"} numberOfLines={1} style={{ flex: 1 }}>
          {project.name}
        </Text>
        {project.taskProgress != null ? (
          <ProgressRing value={project.taskProgress} size={14} stroke={2.5} />
        ) : null}
      </Pressable>
    </View>
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
  onCancel: () => void;
}) {
  // Commit on blur (click away). onSubmit no-ops on an empty value, so blurring an
  // untouched field simply closes it.
  return (
    <View style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}>
      <Input size="sm" autoFocus placeholder={placeholder} value={value} onChangeText={onChangeText} onBlur={onSubmit} />
    </View>
  );
}

const styles = {
  sectionHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingLeft: space.sm,
    paddingRight: space.xs,
    height: 28,
    marginTop: space.xl,
  },
  areaHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingLeft: space.sm,
    paddingRight: space.xs,
    height: 26,
  },
  areaDot: { width: 7, height: 7, borderRadius: radius.full },
  projectRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: 32,
    paddingLeft: space.md,
    paddingRight: space.md,
    marginLeft: space.sm,
    borderRadius: radius.md,
    // Always a 1px border (transparent by default) so the drop-target highlight can color
    // it without shifting layout.
    borderWidth: 1,
  },
  projectDot: { width: 8, height: 8, borderRadius: radius.full, flexShrink: 0 },
};
