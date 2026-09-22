import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import type { CanvasNodeInput, Task } from "@companion/core-bridge";
import { agendaPatch } from "./CalendarAgenda";
import { useCalendar } from "./CalendarProvider";
import { ConfirmDialog, PromptDialog } from "./ConfirmDialog";
import { contextMenuProps, openContextMenu, type MenuEntry } from "./contextMenu";
import { useCore } from "./CoreContext";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { MembershipPicker } from "./MembershipPicker";
import { useNav, type ContainerRef, type DocRef } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useProjects } from "./ProjectsProvider";
import { useTasks } from "./TasksProvider";
import { NODE_DEFAULTS } from "./canvas/host";
import { useCanvases } from "./canvas/CanvasesProvider";
import { localDay } from "./paletteModel";
import { UNTITLED, titleFieldValue } from "./untitled";

// Right-click menus for the things the app lists (web/desktop; see contextMenu.ts for how a
// menu is shown): a note, task or canvas in a browse list; an area or project in the sidebar;
// a `[[type:id]]` reference chip, in chat or in any editor. One provider builds them all and
// owns the dialogs their entries open (rename, move, delete), so every surface offers the same
// actions the same way.

type DocKind = DocRef["kind"];

type Dialog =
  | { kind: "rename-doc"; doc: DocRef; title: string }
  | { kind: "move-doc"; doc: DocRef }
  | { kind: "delete-doc"; doc: DocRef; title: string }
  | { kind: "rename-container"; container: ContainerRef; name: string }
  | { kind: "delete-project"; id: string; name: string }
  | { kind: "delete-area"; id: string; name: string };

interface ItemMenus {
  /** `onAgenda`: the item is already on the agenda it was right-clicked in (no "Add to Today's
   *  Agenda"). */
  docMenu: (doc: DocRef, opts?: { onAgenda?: boolean }) => MenuEntry[];
  containerMenu: (container: ContainerRef) => MenuEntry[];
  refMenu: (type: string, id: string) => MenuEntry[];
}

const ItemMenusCtx = createContext<ItemMenus | null>(null);

const KIND_LABEL: Record<DocKind, string> = { note: "Note", task: "Task", canvas: "Canvas" };
/** Canvases a reference can be embedded on: notes and tasks are the kinds a card shows. */
const CANVAS_REF_KINDS = new Set(["note", "task"]);
/** How many boards "Add to Canvas" lists — the most recently edited. */
const CANVAS_MENU_MAX = 12;

export function ItemMenusProvider({ children }: { children: ReactNode }) {
  const nav = useNav();
  const notes = useNotes();
  const tasks = useTasks();
  const canvases = useCanvases();
  const projects = useProjects();
  const { range } = useCalendar();
  const { canvases: canvasApi } = useCore();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = useCallback(() => setDialog(null), []);

  const titleOf = useCallback(
    (doc: DocRef): string => {
      if (doc.kind === "note") return notes.byId(doc.id)?.title ?? "";
      if (doc.kind === "task") return tasks.byId(doc.id)?.title ?? "";
      return canvases.byId(doc.id)?.name ?? "";
    },
    [notes, tasks, canvases],
  );

  // --- document actions -------------------------------------------------------------------

  /** File a copy where the original lives (its project or area), if anywhere. */
  const fileLike = useCallback(
    async (kind: DocKind, fromId: string, toId: string) => {
      const [m] = (await projects.membershipsFor(kind, fromId)).filter((x) => !x.deletedAt);
      if (!m) return;
      if (m.containerType === "area") await projects.addAreaMember(m.projectId, kind, toId);
      else await projects.addMember(m.projectId, kind, toId);
    },
    [projects],
  );

  const duplicate = useCallback(
    async (doc: DocRef) => {
      const copyName = (t: string) => `${titleFieldValue(t) || UNTITLED[doc.kind]} copy`;
      if (doc.kind === "note") {
        const n = notes.byId(doc.id);
        if (!n) return;
        const made = await notes.create({ title: copyName(n.title), contentMd: n.contentMd });
        if (n.objectTypeId) await notes.update(made.id, { objectTypeId: n.objectTypeId, props: n.props });
        await fileLike("note", n.id, made.id);
        nav.openNote(made.id);
      } else if (doc.kind === "task") {
        const t = tasks.byId(doc.id);
        if (!t) return;
        const made = await tasks.create({
          title: copyName(t.title),
          notesMd: t.notesMd,
          startAt: t.startAt ?? null,
          someday: t.someday,
          dueAt: t.dueAt ?? null,
          reminders: t.reminders,
          objectTypeId: t.objectTypeId ?? null,
          props: t.props,
        });
        await fileLike("task", t.id, made.id);
        nav.openTask(made.id);
      } else {
        // A board is its nodes and the edges between them: copy the nodes, then the edges with
        // their ends pointed at the copies.
        const src = await canvasApi.get(doc.id);
        const made = await canvases.create(copyName(src.canvas.name));
        if (src.nodes.length) {
          const inputs: CanvasNodeInput[] = src.nodes.map((n) => ({
            kind: n.kind,
            x: n.x,
            y: n.y,
            width: n.width,
            height: n.height,
            z: n.z,
            color: n.color ?? null,
            refType: n.refType,
            refId: n.refId ?? null,
            data: n.data ?? {},
          }));
          const saved = await canvasApi.nodes.upsert(made.id, inputs);
          const idMap = new Map(src.nodes.map((n, i) => [n.id, saved[i]?.id]));
          const edges = src.edges
            .filter((e) => idMap.get(e.fromNodeId) && idMap.get(e.toNodeId))
            .map((e) => ({
              fromNodeId: idMap.get(e.fromNodeId)!,
              toNodeId: idMap.get(e.toNodeId)!,
              fromSide: e.fromSide,
              toSide: e.toSide,
              fromEnd: e.fromEnd,
              toEnd: e.toEnd,
              style: e.style,
              label: e.label,
              color: e.color ?? null,
            }));
          if (edges.length) await canvasApi.edges.upsert(made.id, edges);
        }
        await fileLike("canvas", doc.id, made.id);
        nav.openCanvas(made.id);
      }
    },
    [notes, tasks, canvases, canvasApi, fileLike, nav],
  );

  const rename = useCallback(
    async (doc: DocRef, title: string) => {
      if (doc.kind === "note") await notes.update(doc.id, { title });
      else if (doc.kind === "task") await tasks.update(doc.id, { title });
      else await canvases.rename(doc.id, title);
    },
    [notes, tasks, canvases],
  );

  const remove = useCallback(
    async (doc: DocRef) => {
      if (doc.kind === "note") await notes.remove(doc.id);
      else if (doc.kind === "task") await tasks.remove(doc.id);
      else await canvases.remove(doc.id);
    },
    [notes, tasks, canvases],
  );

  // --- references -------------------------------------------------------------------------

  /** Put a note or task on a board, to the right of what's there already. */
  const addToCanvas = useCallback(
    async (canvasId: string, type: "note" | "task", id: string) => {
      const board = await canvasApi.get(canvasId);
      const size = NODE_DEFAULTS[type];
      const right = board.nodes.length ? Math.max(...board.nodes.map((n) => n.x + n.width)) + 40 : 0;
      const top = board.nodes.length ? Math.min(...board.nodes.map((n) => n.y)) : 0;
      await canvasApi.nodes.upsert(canvasId, [{ kind: type, refType: type, refId: id, x: right, y: top, width: size.width, height: size.height, data: {} }]);
    },
    [canvasApi],
  );

  const addToAgenda = useCallback(
    async (task: Task) => {
      await tasks.update(task.id, await agendaPatch(task, localDay(new Date()), range));
    },
    [tasks, range],
  );

  const canvasEntries = useCallback(
    (type: string, id: string): MenuEntry => {
      if (!CANVAS_REF_KINDS.has(type)) return { label: "Add to Canvas", disabled: true };
      const kind = type as "note" | "task";
      const recent = [...canvases.canvases].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, CANVAS_MENU_MAX);
      return {
        label: "Add to Canvas",
        children: [
          ...recent.map((c) => ({ label: c.name || UNTITLED.canvas, run: () => void addToCanvas(c.id, kind, id) })),
          ...(recent.length ? (["separator"] as MenuEntry[]) : []),
          {
            label: "New Canvas",
            run: () =>
              void (async () => {
                const board = await canvases.create();
                await addToCanvas(board.id, kind, id);
                nav.openCanvas(board.id);
              })(),
          },
        ],
      };
    },
    [canvases, addToCanvas, nav],
  );

  const agendaEntry = useCallback(
    (type: string, id: string): MenuEntry => {
      const task = type === "task" ? tasks.byId(id) : undefined;
      return { label: "Add to Today’s Agenda", disabled: task?.status !== "open", run: task ? () => void addToAgenda(task) : undefined };
    },
    [tasks, addToAgenda],
  );

  /** Add to Area ▸ / Add to Project ▸ for a note, task or canvas. Filing is a move, as when it
   *  is dropped on the sidebar: the item leaves whatever area or project held it. Projects are
   *  listed under their areas, in sidebar order. */
  const fileEntries = useCallback(
    (doc: DocRef): MenuEntry[] => {
      const { areas, projects: open, addAreaMember, addMember } = projects;
      const inArea = (areaId: string) => open.filter((p) => p.areaId === areaId).sort((a, b) => a.sortOrder - b.sortOrder);
      const projectEntry = (p: { id: string; name: string }): MenuEntry => ({ label: p.name, run: () => void addMember(p.id, doc.kind, doc.id) });
      const withProjects = areas.filter((a) => inArea(a.id).length);
      return [
        { label: "Add to Area", disabled: !areas.length, children: areas.map((a) => ({ label: a.name, run: () => void addAreaMember(a.id, doc.kind, doc.id) })) },
        {
          label: "Add to Project",
          disabled: !withProjects.length,
          // One area: its projects straight away; several: a submenu per area.
          children:
            withProjects.length === 1
              ? inArea(withProjects[0].id).map(projectEntry)
              : withProjects.map((a) => ({ label: a.name, children: inArea(a.id).map(projectEntry) })),
        },
      ];
    },
    [projects],
  );

  // --- menus ------------------------------------------------------------------------------

  const docMenu = useCallback(
    (doc: DocRef, opts?: { onAgenda?: boolean }): MenuEntry[] => {
      const title = titleOf(doc);
      return [
        { label: "Open in New Tab", run: () => nav.openInNewTab(doc) },
        "separator",
        { label: "Rename…", run: () => setDialog({ kind: "rename-doc", doc, title }) },
        { label: "Move to…", run: () => setDialog({ kind: "move-doc", doc }) },
        { label: "Duplicate", run: () => void duplicate(doc) },
        ...(doc.kind !== "canvas" ? (["separator", canvasEntries(doc.kind, doc.id)] as MenuEntry[]) : []),
        ...(doc.kind === "task" && !opts?.onAgenda ? [agendaEntry("task", doc.id)] : []),
        "separator",
        { label: `Delete ${KIND_LABEL[doc.kind]}`, run: () => setDialog({ kind: "delete-doc", doc, title }) },
      ];
    },
    [titleOf, nav, duplicate, canvasEntries, agendaEntry],
  );

  const containerMenu = useCallback(
    (container: ContainerRef): MenuEntry[] => {
      const { areas, sidebar, projectById, updateProject, reorderAreas } = projects;
      if (container.kind === "project") {
        const project = projectById(container.id);
        if (!project) return [];
        return [
          { label: "Open", run: () => nav.openProject(project.id) },
          "separator",
          { label: "Rename…", run: () => setDialog({ kind: "rename-container", container, name: project.name }) },
          {
            label: "Move to Area",
            children: areas.map((a) => ({
              label: a.name,
              checked: a.id === project.areaId,
              run: a.id === project.areaId ? undefined : () => void updateProject(project.id, { areaId: a.id }),
            })),
          },
          "separator",
          { label: "Delete Project…", run: () => setDialog({ kind: "delete-project", id: project.id, name: project.name }) },
        ];
      }
      const at = areas.findIndex((a) => a.id === container.id);
      const area = areas[at];
      if (!area) return [];
      const ids = areas.map((a) => a.id);
      const swap = (by: number) => {
        const next = [...ids];
        [next[at], next[at + by]] = [next[at + by], next[at]];
        void reorderAreas(next);
      };
      // An area is deleted once it's empty of projects (see deleteArea).
      const hasProjects = (sidebar.areas.find((a) => a.id === area.id)?.projects.length ?? 0) > 0;
      return [
        { label: "Open", run: () => nav.openArea(area.id) },
        "separator",
        { label: "Rename…", run: () => setDialog({ kind: "rename-container", container, name: area.name }) },
        { label: "Move Up", disabled: at === 0, run: () => swap(-1) },
        { label: "Move Down", disabled: at === areas.length - 1, run: () => swap(1) },
        "separator",
        { label: hasProjects ? "Delete Area (move its projects out first)" : "Delete Area…", disabled: hasProjects, run: () => setDialog({ kind: "delete-area", id: area.id, name: area.name }) },
      ];
    },
    [projects, nav],
  );

  const refMenu = useCallback(
    (type: string, id: string): MenuEntry[] => {
      const doc = type === "note" || type === "task" || type === "canvas" ? ({ kind: type, id } as DocRef) : null;
      const open: MenuEntry[] = doc
        ? [
            { label: "Open", run: () => nav.openRef(doc) },
            { label: "Open in New Tab", run: () => nav.openInNewTab(doc) },
          ]
        : type === "project"
          ? [{ label: "Open", run: () => nav.openProject(id) }]
          : [];
      return [...open, "separator", ...(doc ? fileEntries(doc) : []), "separator", canvasEntries(type, id), agendaEntry(type, id)];
    },
    [nav, fileEntries, canvasEntries, agendaEntry],
  );

  // Editor chips are ProseMirror DOM (packages/editor wikilinkView: `.pm-wikilink` with
  // data-type / data-id), in every editor at once; one listener here covers them all.
  const refMenuRef = useRef(refMenu);
  refMenuRef.current = refMenu;
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onContextMenu = (e: MouseEvent) => {
      const chip = e.target instanceof Element ? e.target.closest<HTMLElement>(".pm-wikilink[data-type][data-id]") : null;
      if (!chip) return;
      if (openContextMenu({ x: e.clientX, y: e.clientY }, refMenuRef.current(chip.dataset.type ?? "", chip.dataset.id ?? ""))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const value = useMemo(() => ({ docMenu, containerMenu, refMenu }), [docMenu, containerMenu, refMenu]);

  /** Leave a tab that shows what was just deleted. */
  const leaveIfOpen = (match: (ref: NonNullable<typeof nav.activeTab.ref>) => boolean) => {
    const ref = nav.activeTab.ref;
    if (ref && match(ref)) nav.back();
  };

  return (
    <ItemMenusCtx.Provider value={value}>
      {children}
      {dialog?.kind === "rename-doc" ? (
        <PromptDialog
          title={`Rename ${KIND_LABEL[dialog.doc.kind].toLowerCase()}`}
          initialValue={titleFieldValue(dialog.title)}
          placeholder={UNTITLED[dialog.doc.kind]}
          confirmLabel="Rename"
          onConfirm={async (title) => {
            await rename(dialog.doc, title);
            close();
          }}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "move-doc" ? <MembershipPicker entityType={dialog.doc.kind} entityId={dialog.doc.id} portal onClose={close} /> : null}
      {dialog?.kind === "delete-doc" ? (
        <ConfirmDialog
          portal
          title={`Delete ${KIND_LABEL[dialog.doc.kind].toLowerCase()}?`}
          message={`“${titleFieldValue(dialog.title) || UNTITLED[dialog.doc.kind]}” moves to the Trash, where it stays for 30 days.`}
          onConfirm={async () => {
            await remove(dialog.doc);
            close();
          }}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "rename-container" ? (
        <PromptDialog
          title={dialog.container.kind === "project" ? "Rename project" : "Rename area"}
          initialValue={dialog.name}
          confirmLabel="Rename"
          onConfirm={async (name) => {
            if (dialog.container.kind === "project") await projects.updateProject(dialog.container.id, { name });
            else await projects.updateArea(dialog.container.id, { name });
            close();
          }}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "delete-project" ? (
        <DeleteProjectDialog
          portal
          projectName={dialog.name}
          onConfirm={async (deleteContent) => {
            await projects.deleteProject(dialog.id, deleteContent);
            leaveIfOpen((r) => r.kind === "project" && r.projectId === dialog.id);
            close();
          }}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "delete-area" ? (
        <ConfirmDialog
          portal
          title="Delete area?"
          message={`Delete the area “${dialog.name}”? Anything filed directly in it moves to Unsorted.`}
          confirmLabel="Delete area"
          onConfirm={async () => {
            await projects.deleteArea(dialog.id);
            leaveIfOpen((r) => r.kind === "area" && r.areaId === dialog.id);
            close();
          }}
          onClose={close}
        />
      ) : null}
    </ItemMenusCtx.Provider>
  );
}

/** Right-click props for a note, task or canvas row. Spread on the row (null without a
 *  provider, or off the web). */
export function useDocContextMenu(doc: DocRef | null) {
  const menus = useContext(ItemMenusCtx);
  return contextMenuProps(menus && doc ? () => menus.docMenu(doc) : null);
}

/** Right-click props for a sidebar area or project. */
export function useContainerContextMenu(container: ContainerRef | null) {
  const menus = useContext(ItemMenusCtx);
  return contextMenuProps(menus && container ? () => menus.containerMenu(container) : null);
}

/** Right-click props for a `[[type:id]]` reference chip outside the editor (chat). */
export function useRefContextMenu(type: string, id: string) {
  const menus = useContext(ItemMenusCtx);
  return contextMenuProps(menus ? () => menus.refMenu(type, id) : null);
}

/** The same, for lists that render rows in a loop (hooks can't run per row): a function from a
 *  row's document to its right-click props. */
export function useDocContextMenus(): (doc: DocRef) => ReturnType<typeof contextMenuProps> {
  const menus = useContext(ItemMenusCtx);
  return useCallback((doc: DocRef) => contextMenuProps(menus ? () => menus.docMenu(doc) : null), [menus]);
}

/** The same, for a loop of sidebar-like container rows (a project list). */
export function useContainerContextMenus(): (container: ContainerRef) => ReturnType<typeof contextMenuProps> {
  const menus = useContext(ItemMenusCtx);
  return useCallback((container: ContainerRef) => contextMenuProps(menus ? () => menus.containerMenu(container) : null), [menus]);
}

/** The menus themselves, for a surface that composes its own (the agenda): null without a
 *  provider. */
export function useItemMenus(): ItemMenus | null {
  return useContext(ItemMenusCtx);
}
