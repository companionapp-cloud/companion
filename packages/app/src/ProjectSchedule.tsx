import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import type { Project, UpdateProjectInput } from "@companion/core-bridge";
import { Button, Icon, Input, Text, colors, radius, space, useDensity } from "@companion/design-system";
import { useCore } from "./CoreContext";
import { useProjects } from "./ProjectsProvider";
import { useTasks } from "./TasksProvider";
import { useSync } from "./SyncProvider";
import { ConfirmDialog } from "./ConfirmDialog";
import { DateField } from "./DateField";
import { DateRow, MetaChip, PresetChip, deadlinePresets, formatWhen, startPresets } from "./TaskEditor";
import {
  PROJECT_REPEAT_FREQS,
  REPEAT_AFTER_UNITS,
  buildProjectRule,
  formatRepeatAfter,
  parseProjectRule,
  parseRepeatAfter,
  projectRepeatLabel,
  type ProjectRepeatFreq,
  type RepeatAfterUnit,
} from "./repeat";

/** A project's schedule (PLAN-scheduling.md §2–3), under its name on the overview: the same
 *  chips-that-expand as a task's — start (or Someday), deadline, repeat — plus the button
 *  that completes it. A completed project shows when it was finished, and a way back.
 *
 *  `openTasks` is how many of its tasks are still open (counted here when the host doesn't
 *  already know): completing confirms first, then finishes them with it, so the whole project
 *  lands in the Logbook together. */
export function ProjectSchedule({ project, openTasks: knownOpenTasks }: { project: Project; openTasks?: number }) {
  const { updateProject } = useProjects();
  const counted = useOpenTaskCount(project.id, knownOpenTasks == null);
  const openTasks = knownOpenTasks ?? counted;
  const touch = useDensity() === "touch";
  const [expanded, setExpanded] = useState<null | "start" | "deadline" | "repeat">(null);
  const [confirming, setConfirming] = useState(false);
  const toggle = (which: NonNullable<typeof expanded>) => setExpanded((cur) => (cur === which ? null : which));
  const save = (fields: UpdateProjectInput) => void updateProject(project.id, fields);

  if (project.completedAt) {
    return (
      <View style={styles.completed}>
        <Icon name="check" size={14} color={colors.success} />
        <Text variant="label" tone="secondary" style={{ flex: 1 }}>
          Completed {formatWhen(project.completedAt)}
        </Text>
        <Button label="Reopen" variant="secondary" size="sm" onPress={() => save({ completed: false })} />
      </View>
    );
  }

  const overdue = !!project.dueAt && new Date(project.dueAt).getTime() < Date.now();
  return (
    <View>
      <View style={styles.row}>
        <MetaChip
          icon="calendar"
          label="Add start"
          display={project.someday ? "someday" : project.startAt ? `starts ${formatWhen(project.startAt)}` : null}
          active={expanded === "start"}
          onPress={() => toggle("start")}
          onClear={project.someday ? () => save({ someday: false }) : project.startAt ? () => save({ clearStartAt: true }) : undefined}
        />
        <MetaChip
          icon="flag"
          label="Add deadline"
          display={project.dueAt ? formatWhen(project.dueAt) : null}
          tone={overdue ? "danger" : "default"}
          active={expanded === "deadline"}
          onPress={() => toggle("deadline")}
          onClear={project.dueAt ? () => save({ clearDueAt: true }) : undefined}
        />
        <MetaChip
          icon="repeat"
          label="Repeat"
          display={projectRepeatLabel(project)}
          active={expanded === "repeat"}
          onPress={() => toggle("repeat")}
          onClear={project.repeatRule || project.repeatAfter ? () => save({ clearRepeat: true }) : undefined}
        />
        <View style={{ flex: 1 }} />
        <Button label="Complete" variant="secondary" size="sm" onPress={() => (openTasks > 0 ? setConfirming(true) : save({ completed: true }))} />
      </View>

      {expanded === "start" ? (
        <View style={[styles.editor, touch ? null : styles.narrow]}>
          <DateRow
            value={project.startAt}
            onSet={(iso) => save({ startAt: iso })}
            onClear={() => save({ clearStartAt: true })}
            presets={startPresets()}
            someday={{ active: project.someday, onToggle: () => save({ someday: !project.someday }) }}
            nlPlaceholder="Type a start, e.g. monday 9am"
          />
          {project.someday ? (
            <Text variant="caption" tone="tertiary" style={styles.hint}>
              A Someday project stays off the sidebar, listed on its area’s overview. Its tasks are filed under Someday with it.
            </Text>
          ) : null}
        </View>
      ) : null}

      {expanded === "deadline" ? (
        <View style={[styles.editor, touch ? null : styles.narrow]}>
          <DateRow
            value={project.dueAt}
            onSet={(iso) => save({ dueAt: iso })}
            onClear={() => save({ clearDueAt: true })}
            presets={deadlinePresets()}
            nlPlaceholder="Type a deadline, e.g. next friday"
          />
        </View>
      ) : null}

      {expanded === "repeat" ? (
        <View style={[styles.editor, touch ? null : styles.narrow]}>
          <ProjectRepeatRow project={project} onSave={save} />
        </View>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Complete “${project.name}”?`}
          message={`${openTasks === 1 ? "Its 1 open task" : `Its ${openTasks} open tasks`} will be marked done with it. The project moves to the Logbook.`}
          confirmLabel="Complete project"
          tone="primary"
          portal
          onConfirm={() => {
            save({ completed: true, completeTasks: true });
            setConfirming(false);
          }}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </View>
  );
}

/** How many open tasks are filed in a project, for a host that hasn't loaded its content. */
function useOpenTaskCount(projectId: string, enabled: boolean): number {
  const { core } = useCore();
  const { membershipsForProject } = useProjects();
  const { tasks } = useTasks();
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      void membershipsForProject(projectId).then((members) => {
        if (alive) setMemberIds(new Set(members.filter((m) => m.entityType === "task").map((m) => m.entityId)));
      });
    load();
    const off = core.on("nav.changed", load);
    return () => {
      alive = false;
      off();
    };
  }, [core, enabled, projectId, membershipsForProject]);
  return useMemo(() => tasks.filter((t) => t.status === "open" && memberIds.has(t.id)).length, [tasks, memberIds]);
}

/** The repeat control: not at all, a fixed interval after the project is completed, or every
 *  day / week / month — optionally until an end date. Every change saves straight away. */
function ProjectRepeatRow({ project, onSave }: { project: Project; onSave: (fields: UpdateProjectInput) => void }) {
  const { connected } = useSync();
  const after = parseRepeatAfter(project.repeatAfter);
  const { freq, until } = parseProjectRule(project.repeatRule);
  const mode: "none" | "after" | ProjectRepeatFreq = after ? "after" : (freq ?? (project.repeatRule ? "WEEKLY" : "none"));

  // The count is typed, so it keeps a draft: an empty or zero field mid-edit isn't saved.
  const [count, setCount] = useState(String(after?.n ?? 1));
  useEffect(() => {
    if (after) setCount(String(after.n));
  }, [after?.n]);
  const unit: RepeatAfterUnit = after?.unit ?? "W";
  const saveAfter = (n: number, u: RepeatAfterUnit) => onSave({ repeatAfter: formatRepeatAfter(n, u) });

  return (
    <View style={{ gap: space.sm }}>
      {!connected ? (
        <View style={styles.cta}>
          <Icon name="repeat" size={14} color={colors.textTertiary} />
          <View style={{ flex: 1, gap: space.xxs }}>
            <Text variant="label" tone="secondary">
              Repeats need a connected sync server
            </Text>
            <Text variant="caption" tone="tertiary">
              The next copy of a repeating project is made on your sync server. Connect one to make projects recur.
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.presets}>
        <PresetChip label="Does not repeat" active={mode === "none"} onPress={() => onSave({ clearRepeat: true })} />
        <PresetChip label="After completion" active={mode === "after"} onPress={() => saveAfter(Number(count) || 1, unit)} />
        {PROJECT_REPEAT_FREQS.map((f) => (
          <PresetChip key={f.freq} label={f.label} active={mode === f.freq} onPress={() => onSave({ repeatRule: buildProjectRule(f.freq, until) })} />
        ))}
      </View>

      {mode === "after" ? (
        <View style={styles.inline}>
          <View style={{ width: 64 }}>
            <Input
              size="sm"
              value={count}
              placeholder="1"
              onChangeText={(t) => {
                const digits = t.replace(/\D/g, "").slice(0, 3);
                setCount(digits);
                if (Number(digits) >= 1) saveAfter(Number(digits), unit);
              }}
            />
          </View>
          <View style={styles.presets}>
            {REPEAT_AFTER_UNITS.map((u) => (
              <PresetChip key={u.unit} label={u.label} active={unit === u.unit} onPress={() => saveAfter(Number(count) || 1, u.unit)} />
            ))}
          </View>
          <Text variant="caption" tone="tertiary">
            after completion
          </Text>
        </View>
      ) : null}

      {mode !== "none" && mode !== "after" ? (
        <View style={styles.inline}>
          <Text variant="caption" tone="tertiary">
            Ends
          </Text>
          <PresetChip label="Never" active={!until} onPress={() => onSave({ repeatRule: buildProjectRule(mode, "") })} />
          <View style={{ width: 160 }}>
            <DateField kind="date" value={until} ariaLabel="Stop repeating after" onChange={(v) => onSave({ repeatRule: buildProjectRule(mode, v) })} />
          </View>
        </View>
      ) : null}

      {mode !== "none" ? (
        <Text variant="caption" tone="tertiary" style={styles.hint}>
          {mode === "after"
            ? "When you complete it, a fresh copy appears — its tasks reset to open, its notes and canvases brought along — starting that long after."
            : "Each turn, a fresh copy appears — its tasks reset to open, its notes and canvases brought along — with its dates moved on. The schedule runs from its start (or its deadline)."}
        </Text>
      ) : null}
    </View>
  );
}

const styles = {
  row: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: space.sm, marginTop: space.xs, zIndex: 1 },
  editor: { marginTop: space.sm, marginBottom: space.xs },
  narrow: { maxWidth: 420 },
  presets: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  inline: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: space.sm },
  hint: { lineHeight: 18 },
  completed: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    marginTop: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceSunken,
  },
  cta: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceSunken,
  },
};
