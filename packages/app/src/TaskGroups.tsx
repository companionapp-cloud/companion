import { Fragment, type ReactNode } from "react";
import { View } from "react-native";
import type { Task } from "@companion/core-bridge";
import { Text, space } from "@companion/design-system";
import { scheduleGroups, type DateGroup } from "./taskSchedule";

/** An eyebrow heading over one date group — "Today", "Wed 23", "October", "2027" — with its
 *  count. Sits on the ListSectionFold header's metrics so grouped and folded sections align. */
export function DateGroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <View style={styles.heading}>
      <Text variant="eyebrow" tone="quaternary" numberOfLines={1} style={{ flex: 1 }}>
        {label}
      </Text>
      {/* An empty day (Upcoming lays out the whole month) is just its heading. */}
      {count > 0 ? (
        <Text variant="mono" tone="quaternary">
          {count}
        </Text>
      ) : null}
    </View>
  );
}

/** Rows under date-group headings. */
export function DateGroups<T>({ groups, renderItem }: { groups: DateGroup<T>[]; renderItem: (item: T) => ReactNode }) {
  return (
    <>
      {groups.map((g) => (
        <Fragment key={g.key}>
          <DateGroupHeading label={g.label} count={g.items.length} />
          {g.items.map(renderItem)}
        </Fragment>
      ))}
    </>
  );
}

/** A task list's open rows: grouped by start date under the Upcoming and Overdue views
 *  (PLAN-scheduling.md §5), flat under every other. */
export function ScheduledTasks({ tasks, mode, renderTask }: { tasks: Task[]; mode: string; renderTask: (task: Task) => ReactNode }) {
  const groups = scheduleGroups(tasks, mode);
  if (!groups) return <>{tasks.map(renderTask)}</>;
  return <DateGroups groups={groups} renderItem={renderTask} />;
}

const styles = {
  heading: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    marginTop: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
};
