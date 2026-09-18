import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import type { MemberEntityType, Project } from "@companion/core-bridge";
import { Icon, IconButton, Input, Text, colors, icon, radius, row, shadow, space, useDensity, type PressState } from "@companion/design-system";
import { useProjects } from "./ProjectsProvider";
import { Overlay } from "./Overlay";

/** A popover to add/remove an entity (a note, task or canvas — or a calendar) to/from
 * projects — the "membership edited from either end" picker (PLAN §6.6). Reflects the
 * entity's current memberships as toggles over every project, grouped by area. */
export function MembershipPicker({
  entityType,
  entityId,
  subtitle,
  portal,
  onClose,
}: {
  entityType: MemberEntityType;
  entityId: string;
  /** A line under the title saying what filing this entity does. */
  subtitle?: string;
  /** Lift the picker to the viewport (web), for hosts inside a scrolling page. */
  portal?: boolean;
  onClose: () => void;
}) {
  const { projects, areas, addMember, removeMember, membershipsFor } = useProjects();
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void membershipsFor(entityType, entityId).then((rows) => {
      if (cancelled) return;
      setMemberOf(new Set(rows.map((m) => m.projectId)));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [membershipsFor, entityType, entityId]);

  // Area label per project (for a bit of context), with "Unsorted" for dangling areas.
  const areaName = useMemo(() => {
    const m = new Map(areas.map((a) => [a.id, a.name]));
    return (areaId: string) => m.get(areaId) ?? "Unsorted";
  }, [areas]);

  const toggle = async (projectId: string) => {
    const isMember = memberOf.has(projectId);
    // Optimistic: flip immediately, reconcile on failure.
    setMemberOf((prev) => {
      const next = new Set(prev);
      if (isMember) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    try {
      if (isMember) await removeMember(projectId, entityType, entityId);
      else await addMember(projectId, entityType, entityId);
    } catch {
      setMemberOf((prev) => {
        const next = new Set(prev);
        if (isMember) next.add(projectId);
        else next.delete(projectId);
        return next;
      });
    }
  };

  const shown = filterProjects(projects, query);

  return (
    <PickerShell title="Add to projects" subtitle={subtitle} portal={portal} onClose={onClose}>
      {projects.length > SEARCH_THRESHOLD ? <PickerSearch placeholder="Search projects" value={query} onChangeText={setQuery} /> : null}
      <ScrollView contentContainerStyle={pickerStyles.body}>
        {projects.length === 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            No projects yet. Create one from the sidebar.
          </Text>
        ) : shown.length === 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            No projects match that.
          </Text>
        ) : (
          shown.map((p) => {
            const on = memberOf.has(p.id);
            return (
              <PickerRow key={p.id} onPress={() => void toggle(p.id)} disabled={!loaded} label={p.name} meta={areaName(p.areaId)} color={p.color ?? null} leading={<PickerCheck checked={on} />} />
            );
          })
        )}
      </ScrollView>
    </PickerShell>
  );
}

// ---- Shared picker chrome (MembershipPicker, BulkAssignPicker, AddTasksPicker) ----------

/** Above this many rows a picker grows a search field. */
export const SEARCH_THRESHOLD = 6;

export function filterProjects(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
}

/** The modal panel every picker shares: a scrim, then an overlay-surface panel (radius 8,
 *  `shadow.lg` — it floats above the document) with a title row and a close button. With
 *  `portal` the scrim is lifted to the document root on web (see Overlay.web.tsx). */
export function PickerShell({
  title,
  subtitle,
  width = 360,
  portal,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  width?: number;
  portal?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = (
    <View style={[pickerStyles.scrim, portal ? pickerStyles.scrimPortal : null]}>
      <Pressable style={pickerStyles.scrimFill} onPress={onClose} aria-label="Close" />
      <View style={[pickerStyles.panel, { width }]}>
        <View style={pickerStyles.header}>
          <Text variant="title" numberOfLines={1} style={{ flex: 1 }}>
            {title}
          </Text>
          <IconButton label="Close" size="sm" onPress={onClose}>
            <Icon name="close" size={13} color={colors.textSecondary} />
          </IconButton>
        </View>
        {subtitle ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
        {children}
      </View>
    </View>
  );
  return portal ? <Overlay>{panel}</Overlay> : panel;
}

export function PickerSearch({ placeholder, value, onChangeText }: { placeholder: string; value: string; onChangeText: (t: string) => void }) {
  const touch = useDensity() === "touch";
  return (
    <View style={pickerStyles.search}>
      <Input
        size={touch ? "lg" : "sm"}
        placeholder={placeholder}
        value={value}
        onChangeText={onChangeText}
        // No autofocus on touch: it would throw the keyboard over the list being picked from.
        autoFocus={!touch}
        leadingIcon={<Icon name="search" size={icon.sm} color={colors.textQuaternary} />}
      />
    </View>
  );
}

/** A picker row: 24px (44 under touch), optional leading control, a swatch dot, the label
 *  and quiet mono metadata. */
export function PickerRow({
  label,
  meta,
  color,
  leading,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  meta?: string;
  /** A project swatch (literal hex). Omit for rows that aren't projects. */
  color?: string | null;
  leading?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const touch = useDensity() === "touch";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ hovered, pressed }: PressState) => [
        pickerStyles.row,
        { minHeight: touch ? row.touch : row.h },
        { backgroundColor: selected ? colors.surfaceSelected : pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
      ]}
    >
      {leading}
      {color !== undefined ? <View style={[pickerStyles.dot, { backgroundColor: color ?? colors.borderStrong }]} /> : null}
      <Text variant="label" tone={selected ? "accent" : "default"} numberOfLines={1} style={{ flex: 1 }}>
        {label}
      </Text>
      {meta ? (
        <Text variant="mono" tone="quaternary" numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** The dense checkbox: 12px (18 under touch), 1px strong border, radius 2, accent fill and
 *  a white check when on. Display-only — the row is the press target. */
export function PickerCheck({ checked }: { checked: boolean }) {
  const touch = useDensity() === "touch";
  const size = touch ? 18 : 12;
  return (
    <View style={[pickerStyles.check, { width: size, height: size }, checked ? pickerStyles.checkOn : null]}>
      {checked ? <Icon name="check" size={size - 3} color={colors.onAccent} strokeWidth={2.5} /> : null}
    </View>
  );
}

export const pickerStyles = {
  scrim: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: colors.scrim,
    padding: space.xl,
    zIndex: 100,
  },
  // Portaled to document.body on web, so `fixed` pins it to the viewport above every pane
  // and toolbar; native has no fixed positioning and covers its screen.
  scrimPortal: { position: (Platform.OS === "web" ? "fixed" : "absolute") as "absolute", zIndex: 1000 },
  scrimFill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  panel: {
    maxWidth: "100%" as const,
    maxHeight: "80%" as const,
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    overflow: "hidden" as const,
  },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingLeft: space.lg,
    paddingRight: space.md,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  subtitle: { paddingHorizontal: space.lg, paddingBottom: space.md, lineHeight: 18 },
  search: { paddingHorizontal: space.md, paddingBottom: space.sm },
  body: { padding: space.xs, gap: 1 },
  empty: { padding: space.lg, textAlign: "center" as const, lineHeight: 18 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  check: {
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  dot: { width: 6, height: 6, borderRadius: radius.full, flexShrink: 0 },
  footer: {
    flexDirection: "row" as const,
    justifyContent: "flex-end" as const,
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
};
