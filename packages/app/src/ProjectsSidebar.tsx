import { useCallback, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { SidebarArea, SidebarProject } from "@companion/core-bridge";
import { Icon, Input, ProgressRing, Text, colors, icon, motion, noDragRegion, radius, space, transition, type IconName, type PressState } from "@companion/design-system";
import { useProjects } from "./ProjectsProvider";
import { SortableList } from "./SortableList";
import { useDropTarget, type DragPayload } from "./DndContext";
import { SECTION_OF, containerOfLocation, useNav, type ContainerRef } from "./nav-context";
import { TourAnchor } from "./onboarding/anchors";

/** The areas → projects tree in the expanded rail (PLAN §6.6): area headings that open the
 * area's page, project nav items with a task-completion ring (hidden until member tasks
 * exist), an "Unsorted" bucket for dangling areas, and inline create affordances. Areas and
 * the projects within each area are drag-reorderable (drag a row; a tap still navigates). */
export function ProjectsSidebar({
  onSelectProject,
  activeProjectId,
  onSelectArea,
  activeAreaId,
  onDeleteArea,
}: {
  onSelectProject?: (id: string) => void;
  activeProjectId?: string | null;
  onSelectArea?: (id: string) => void;
  activeAreaId?: string | null;
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
  const { collapsed, toggle, expand } = useCollapsedAreas();

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
    <View style={styles.area}>
      <AreaHeader
        area={area}
        open={!collapsed.has(area.id)}
        active={area.id === activeAreaId}
        onOpen={() => onSelectArea?.(area.id)}
        onToggle={() => toggle(area.id)}
        dragHandlers={dragHandlers}
        onAddProject={() => {
          // Creating into a collapsed area opens it, so the input (and the result) show.
          expand(area.id);
          setAddingProjectFor(area.id);
          setProjectName("");
        }}
        onDeleteArea={onDeleteArea}
      />
      {collapsed.has(area.id) ? null : (
        <SortableList
          // Someday projects are filed away: off the rail, listed on the area's overview.
          items={area.projects.filter((p) => !p.someday)}
          keyExtractor={(p) => p.id}
          onReorder={(ids) => void reorderProjects(area.id, ids)}
          renderItem={({ item: p, isActive, drag }) => (
            <View {...drag}>
              <ProjectRow project={p} areaId={area.id} active={p.id === activeProjectId} dragging={isActive} onPress={() => onSelectProject?.(p.id)} />
            </View>
          )}
        />
      )}
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
    // The areas tour points at the whole tree.
    <TourAnchor id="sidebar.areas">
      <View style={[styles.header, styles.area]}>
        <Text variant="eyebrow" tone="quaternary" numberOfLines={1} style={{ flex: 1 }}>
          Areas
        </Text>
        <MiniButton label="New area" icon="plus" onPress={() => setAddingArea((v) => !v)} />
      </View>

      <SortableList
        items={sidebar.areas}
        keyExtractor={(a) => a.id}
        onReorder={(ids) => void reorderAreas(ids)}
        renderItem={({ item: area, drag }) => renderArea(area, drag)}
      />

      {sidebar.unsorted.length > 0 ? (
        <View style={styles.area}>
          <View style={styles.header}>
            <Text variant="eyebrow" tone="quaternary" numberOfLines={1} style={{ flex: 1 }}>
              Unsorted
            </Text>
          </View>
          {/* Someday ones included: with no area, there is no overview to find them on. */}
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
        <Text tone="tertiary" variant="caption" style={styles.empty}>
          Group your work into areas and projects. Add one with ＋.
        </Text>
      ) : null}
    </TourAnchor>
  );
}

const COLLAPSED_KEY = "companion.rail.collapsedAreas";

/** Which areas are folded shut. Per-device, mirrored to localStorage (absent on native and
 *  in some sandboxes, hence the guards) — the tree unmounts whenever the rail collapses, so
 *  plain state would forget a fold every time the pointer left the rail. */
function useCollapsedAreas() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = globalThis.localStorage?.getItem(COLLAPSED_KEY);
      const ids: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  });
  const update = useCallback((fn: (next: Set<string>) => void) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      fn(next);
      try {
        globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Storage is best-effort.
      }
      return next;
    });
  }, []);
  const toggle = useCallback((id: string) => update((n) => (n.has(id) ? n.delete(id) : n.add(id))), [update]);
  const expand = useCallback((id: string) => update((n) => n.delete(id)), [update]);
  return { collapsed, toggle, expand };
}

/** A 16px affordance button for the 18px eyebrow headers (an `sm` IconButton is taller than
 *  the row it would sit in). Fill steps on hover/press like every other control. */
function MiniButton({ label, icon: name, onPress }: { label: string; icon: IconName; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.mini,
        noDragRegion,
        { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
      ]}
    >
      <Icon name={name} size={icon.sm} color={colors.textQuaternary} />
    </Pressable>
  );
}

/** An area heading: an 18px mono eyebrow with a fold chevron, an optional emoji or colour
 *  dot, and the always-present "new project" button. The chevron folds the area; the name
 *  opens its page (PLAN-areas.md §3). An empty area additionally reveals a delete button on
 *  hover — areas are only deletable once they hold no projects (PLAN §6.6). The whole header
 *  is the area's drag handle, and a drop target: a dragged note, task or canvas is filed in the
 *  area, and a dragged reference to a project moves that project into it. */
/** After a drop moves a document into `target`: if the active tab has that document selected
 *  inside the project/area page it just left, clear the selection rather than leaving it open
 *  under a container that no longer lists it. `targetAreaId` is the area a target project
 *  sits in — an area page rolls up its projects, so it still lists the item. */
function useClearMovedSelection() {
  const nav = useNav();
  return (target: ContainerRef, targetAreaId: string | null, p: DragPayload) => {
    if (p.kind === "project") return;
    const here = containerOfLocation(nav.current);
    const section = SECTION_OF[p.kind];
    if (!here || here.section !== section || here.itemId !== p.id) return;
    if (here.kind === target.kind && here.id === target.id) return;
    if (here.kind === "area" && target.kind === "project" && targetAreaId === here.id) return;
    // Replace, not push: Back shouldn't return to the item under the container it left.
    nav.replaceRef(here.kind === "project" ? { kind: "project", projectId: here.id, section } : { kind: "area", areaId: here.id, section });
  };
}

function AreaHeader({
  area,
  open,
  active,
  onOpen,
  onToggle,
  dragHandlers,
  onAddProject,
  onDeleteArea,
}: {
  area: SidebarArea;
  open: boolean;
  active?: boolean;
  onOpen: () => void;
  onToggle: () => void;
  dragHandlers: object;
  onAddProject: () => void;
  onDeleteArea?: (area: SidebarArea) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { addAreaMember, updateProject, projectById } = useProjects();
  const clearMoved = useClearMovedSelection();
  const { ref, isOver } = useDropTarget(
    `area:${area.id}`,
    (p) => {
      if (p.kind === "project") void updateProject(p.id, { areaId: area.id });
      else void addAreaMember(area.id, p.kind, p.id).then(() => clearMoved({ kind: "area", id: area.id }, null, p));
    },
    // A project already in this area has nowhere to move.
    { accepts: (p) => p.kind !== "project" || (!!projectById(p.id) && projectById(p.id)?.areaId !== area.id) },
  );
  const on = isOver || !!active;
  const deletable = area.projects.length === 0 && !!onDeleteArea;
  let trailing: ReactNode = null;
  if (deletable && hovered) trailing = <MiniButton label={`Delete area ${area.name}`} icon="trash" onPress={() => onDeleteArea?.(area)} />;
  return (
    <View
      ref={ref}
      style={[styles.header, styles.areaHeader, { backgroundColor: on ? colors.accentSoft : "transparent", borderColor: isOver ? colors.accent : "transparent" }]}
      {...dragHandlers}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Pressable onPress={onToggle} aria-label={`${open ? "Collapse" : "Expand"} ${area.name}`} style={[styles.fold, noDragRegion]}>
        <View style={[{ transform: [{ rotate: open ? "90deg" : "0deg" }] }, transition("transform", motion.fast)]}>
          <Icon name="chevronRight" size={10} color={colors.textQuaternary} />
        </View>
      </Pressable>
      <Pressable onPress={onOpen} aria-label={`Open area ${area.name}`} style={styles.headerLabel}>
        {area.icon ? (
          <Text style={styles.areaEmoji}>{area.icon}</Text>
        ) : area.color ? (
          <View style={[styles.areaDot, { backgroundColor: area.color }]} />
        ) : null}
        <Text variant="eyebrow" tone={on ? "accent" : hovered ? "secondary" : "quaternary"} numberOfLines={1} style={{ flex: 1 }}>
          {area.name}
        </Text>
      </Pressable>
      {trailing}
      <MiniButton label={`New project in ${area.name}`} icon="plus" onPress={onAddProject} />
    </View>
  );
}

function ProjectRow({
  project,
  areaId,
  active,
  dragging,
  onPress,
}: {
  project: SidebarProject;
  /** The area this project sits under (none in the "Unsorted" bucket). */
  areaId?: string;
  active?: boolean;
  dragging?: boolean;
  onPress?: () => void;
}) {
  const { addMember } = useProjects();
  // A project is a drop target: dropping a dragged note, task or canvas files it in this
  // project. (A project doesn't go in a project.)
  const clearMoved = useClearMovedSelection();
  const { ref, isOver } = useDropTarget(
    project.id,
    (p) => {
      if (p.kind === "project") return;
      void addMember(project.id, p.kind, p.id).then(() => clearMoved({ kind: "project", id: project.id }, areaId ?? null, p));
    },
    { accepts: (p) => p.kind !== "project" },
  );
  const on = isOver || !!active;
  return (
    <View ref={ref} style={styles.projectSlot}>
      <Pressable
        onPress={onPress}
        aria-label={project.name}
        style={({ hovered, pressed }: PressState) => [
          styles.projectRow,
          noDragRegion,
          transition("background-color", motion.fast),
          {
            backgroundColor: on ? colors.accentSoft : dragging || pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent",
            borderColor: isOver ? colors.accent : "transparent",
          },
        ]}
      >
        {/* The project's emoji, else a folder carrying its swatch; selection overrides the
            swatch, as everywhere. */}
        {project.icon ? (
          <Text style={styles.projectEmoji}>{project.icon}</Text>
        ) : (
          <Icon name="folder" size={icon.md} color={on ? colors.textAccent : (project.color ?? colors.textTertiary)} />
        )}
        <Text variant="label" tone={on ? "accent" : "secondary"} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
          {project.name}
        </Text>
        {project.taskProgress != null ? <ProgressRing value={project.taskProgress} /> : null}
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
    <View style={styles.create}>
      <Input size="sm" autoFocus placeholder={placeholder} value={value} onChangeText={onChangeText} onBlur={onSubmit} />
    </View>
  );
}

const styles = {
  // One 10px step above the first group and between groups — the rail's own rhythm.
  area: { marginTop: space.ml },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xxs,
    height: 18,
    paddingLeft: 7,
    paddingRight: space.xs,
    // With the 1px above each project row this makes the 2px under a header.
    marginBottom: 1,
  },
  // An area heading is a nav target and a drop target: the same 1px always-there border as a
  // project row, so highlighting it never shifts the layout.
  areaHeader: { borderWidth: 1, borderRadius: radius.sm, paddingLeft: 2, paddingRight: space.xxs },
  fold: { width: 14, height: 16, alignItems: "center" as const, justifyContent: "center" as const, flexShrink: 0 },
  headerLabel: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, height: 18 },
  // Emoji render at the glyph's own metrics; pin the line box so rows don't grow.
  areaEmoji: { fontSize: 11, lineHeight: 16, flexShrink: 0 },
  projectEmoji: { fontSize: 13, lineHeight: 16, width: icon.md, textAlign: "center" as const, flexShrink: 0 },
  areaDot: { width: 5, height: 5, borderRadius: radius.full, flexShrink: 0 },
  mini: { width: 16, height: 16, borderRadius: radius.xs, alignItems: "center" as const, justifyContent: "center" as const, flexShrink: 0 },
  projectSlot: { marginTop: 1 },
  // Rail-item metrics: 28px, radius 3, 7px padding (6 + the border), 8px gap.
  projectRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: 28,
    paddingHorizontal: 6,
    borderRadius: radius.sm,
    // Always a 1px border (transparent by default) so the drop-target highlight can color
    // it without shifting layout.
    borderWidth: 1,
  },
  create: { paddingTop: space.xs, paddingBottom: space.xxs },
  empty: { paddingHorizontal: 7, paddingVertical: space.sm, lineHeight: 18 },
};
