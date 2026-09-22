import { useState } from "react";
import { ScrollView, View } from "react-native";
import type { CalendarItem } from "@companion/core-bridge";
import { Button, Icon, IconButton, Text, colors, icon, radius, row, space, useDensity } from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";
import { useProjects } from "./ProjectsProvider";
import { useProjectCalendars, type ProjectCalendars } from "./useProjectCalendars";
import { UpcomingAgenda } from "./CalendarAgenda";
import { PickerCheck, PickerRow, PickerSearch, PickerShell, SEARCH_THRESHOLD, pickerStyles } from "./MembershipPicker";
import { listStyles } from "./ProjectLists";

// Calendars in projects (PLAN §6.6): choosing the calendars a project holds, and its Calendar tab.
// What a project holds is resolved by useProjectCalendars.

/** Choose the calendars a project holds: each account — whole, or calendar by calendar — and each
 *  subscription. A tick files it at once, like the project picker on a note. */
export function ProjectCalendarsPicker({
  projectId,
  portal,
  onClose,
}: {
  projectId: string;
  /** Lift the picker to the viewport (web). Native renders it in place over its screen. */
  portal?: boolean;
  onClose: () => void;
}) {
  const { feeds, accounts } = useCalendar();
  const { projects } = useProjects();
  const cals = useProjectCalendars(projectId);
  const [query, setQuery] = useState("");

  const subscriptions = feeds.filter((f) => f.kind !== "caldav");
  const rowCount = subscriptions.length + accounts.reduce((n, a) => n + 1 + a.calendars.length, 0);
  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  // An account matching the search shows all its calendars; otherwise only the calendars that match.
  const shownAccounts = accounts
    .map((a) => ({ account: a, calendars: matches(a.name) ? a.calendars : a.calendars.filter((c) => matches(c.name)) }))
    .filter((x) => matches(x.account.name) || x.calendars.length > 0);
  const shownSubscriptions = subscriptions.filter((f) => matches(f.name));
  const projectName = projects.find((p) => p.id === projectId)?.name;

  return (
    <PickerShell
      title="Calendars"
      subtitle={`Events from these calendars show in ${projectName ? `“${projectName}”` : "this project"}.`}
      portal={portal}
      onClose={onClose}
    >
      {rowCount > SEARCH_THRESHOLD ? <PickerSearch placeholder="Search calendars" value={query} onChangeText={setQuery} /> : null}
      <ScrollView contentContainerStyle={pickerStyles.body}>
        {rowCount === 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            No calendars yet. Connect an account or subscribe to a calendar in Settings › Calendar.
          </Text>
        ) : shownAccounts.length === 0 && shownSubscriptions.length === 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            No calendars match that.
          </Text>
        ) : (
          <>
            {shownAccounts.length > 0 ? (
              <Text variant="eyebrow" tone="quaternary" style={styles.pickerGroup}>
                Accounts
              </Text>
            ) : null}
            {shownAccounts.map(({ account, calendars }) => {
              const whole = cals.accountIds.has(account.id);
              return (
                <View key={account.id} style={styles.pickerAccount}>
                  <PickerRow
                    label={account.name}
                    meta="all calendars"
                    leading={<PickerCheck checked={whole} />}
                    disabled={!cals.loaded}
                    onPress={() => void cals.toggle("calendar_account", account.id).catch(() => undefined)}
                  />
                  {calendars.map((c) => (
                    <View key={c.id} style={styles.pickerNested}>
                      <PickerRow
                        label={c.name}
                        color={c.color ?? null}
                        // Filing the account already brings this calendar in.
                        meta={whole ? "with account" : c.readOnly ? "read-only" : undefined}
                        leading={<PickerCheck checked={whole || cals.feedIds.has(c.id)} />}
                        disabled={!cals.loaded || whole}
                        onPress={() => void cals.toggle("calendar", c.id).catch(() => undefined)}
                      />
                    </View>
                  ))}
                </View>
              );
            })}
            {shownSubscriptions.length > 0 ? (
              <Text variant="eyebrow" tone="quaternary" style={styles.pickerGroup}>
                Subscriptions
              </Text>
            ) : null}
            {shownSubscriptions.map((f) => (
              <PickerRow
                key={f.id}
                label={f.name}
                color={f.color ?? null}
                leading={<PickerCheck checked={cals.feedIds.has(f.id)} />}
                disabled={!cals.loaded}
                onPress={() => void cals.toggle("calendar", f.id).catch(() => undefined)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </PickerShell>
  );
}

/** The calendars a project holds, a row each with a button that takes it out of the project
 *  (the calendar itself stays in Settings › Calendar). */
export function ProjectCalendarRows({ cals }: { cals: ProjectCalendars }) {
  const { accounts } = useCalendar();
  const accountName = (id?: string | null) => accounts.find((a) => a.id === id)?.name;
  return (
    <View style={styles.rows}>
      {cals.accounts.map((a) => (
        <CalendarRow
          key={`account:${a.id}`}
          title={a.name}
          subtitle={a.calendars.length ? `All calendars · ${a.calendars.map((c) => c.name).join(", ")}` : "All calendars"}
          removeLabel={`Take ${a.name} out of this project`}
          onRemove={() => void cals.toggle("calendar_account", a.id).catch(() => undefined)}
        />
      ))}
      {cals.calendars.map((f) => (
        <CalendarRow
          key={`calendar:${f.id}`}
          color={f.color ?? null}
          title={f.name}
          subtitle={
            f.kind === "caldav"
              ? [accountName(f.accountId) ?? "Account", f.readOnly ? "read-only" : null].filter(Boolean).join(" · ")
              : "Subscription · read-only"
          }
          removeLabel={`Take ${f.name} out of this project`}
          onRemove={() => void cals.toggle("calendar", f.id).catch(() => undefined)}
        />
      ))}
    </View>
  );
}

/** One held calendar: a swatch (an account shows the calendar glyph), its name over where it
 *  comes from, and the remove button — always shown, so it is reachable without hovering. */
function CalendarRow({
  title,
  subtitle,
  color,
  removeLabel,
  onRemove,
}: {
  title: string;
  subtitle: string;
  /** A calendar's swatch; omitted for an account. */
  color?: string | null;
  removeLabel: string;
  onRemove: () => void;
}) {
  const touch = useDensity() === "touch";
  return (
    <View style={[styles.row, { minHeight: touch ? row.touch : row.twoLine }]}>
      {color === undefined ? (
        <Icon name="calendar" size={icon.sm} color={colors.textQuaternary} />
      ) : (
        <View style={[styles.swatch, { backgroundColor: color ?? colors.borderStrong }]} />
      )}
      <View style={styles.rowBody}>
        <Text variant="label" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <IconButton label={removeLabel} size={touch ? undefined : "sm"} onPress={onRemove}>
        <Icon name="close" size={touch ? icon.lg : 12} color={colors.textTertiary} />
      </IconButton>
    </View>
  );
}

/** Empty-state copy: what to do depends on whether there is any calendar to add yet. */
function emptyCopy(hasAny: boolean): string {
  return hasAny
    ? "No calendars in this project yet. Add an account, one of its calendars, or a subscription — its events show here beside the project’s tasks."
    : "No calendars yet. Connect an account or subscribe to a calendar in Settings › Calendar, then add it here.";
}

/** The project's Calendars list column (desktop and wide web): what it holds, with ＋ to add.
 *  The week grid beside it is the project's calendar. */
export function ProjectCalendarsColumn({ projectId }: { projectId: string }) {
  const { feeds, accounts } = useCalendar();
  const cals = useProjectCalendars(projectId);
  const [picking, setPicking] = useState(false);
  const count = cals.accounts.length + cals.calendars.length;

  return (
    <View style={listStyles.list}>
      <View style={listStyles.listHeader}>
        <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
          Calendars
        </Text>
        {cals.loaded ? (
          <Text variant="mono" tone="quaternary">
            {count}
          </Text>
        ) : null}
        <IconButton label="Add calendars" size="sm" onPress={() => setPicking(true)}>
          <Icon name="plus" size={icon.sm} color={colors.textSecondary} />
        </IconButton>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={listStyles.scroll}>
        {count > 0 ? (
          <ProjectCalendarRows cals={cals} />
        ) : cals.loaded ? (
          <Text tone="tertiary" variant="caption" style={listStyles.empty}>
            {emptyCopy(feeds.length + accounts.length > 0)}
          </Text>
        ) : null}
      </ScrollView>
      {picking ? <ProjectCalendarsPicker projectId={projectId} portal onClose={() => setPicking(false)} /> : null}
    </View>
  );
}

/** A project's calendar on a phone: the calendars it holds in a card, then what's coming up.
 *  The host renders the picker (`onAdd`) outside its scroll view, where it can cover the screen. */
export function ProjectCalendarsPanel({
  projectId,
  onAdd,
  onOpenItem,
}: {
  projectId: string;
  onAdd: () => void;
  onOpenItem: (item: CalendarItem) => void;
}) {
  const { feeds, accounts } = useCalendar();
  const cals = useProjectCalendars(projectId);
  const count = cals.accounts.length + cals.calendars.length;

  return (
    <View style={styles.panel}>
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text variant="eyebrow" tone="quaternary" style={{ flex: 1 }}>
            Calendars{count > 0 ? ` · ${count}` : ""}
          </Text>
          <Button variant="ghost" size="sm" label="Add" onPress={onAdd} />
        </View>
        {count > 0 ? (
          <ProjectCalendarRows cals={cals} />
        ) : cals.loaded ? (
          <Text tone="tertiary" variant="caption" style={styles.cardEmpty}>
            {emptyCopy(feeds.length + accounts.length > 0)}
          </Text>
        ) : null}
      </View>
      <UpcomingAgenda projectId={projectId} onOpenItem={onOpenItem} />
    </View>
  );
}

const styles = {
  pickerGroup: { paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: 2 },
  pickerAccount: { gap: 1 },
  // An account's calendars sit under it, indented past its checkbox.
  pickerNested: { paddingLeft: space.lg },
  rows: { gap: 1 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingLeft: space.sm,
    paddingRight: space.xxs,
    borderRadius: radius.sm,
  },
  rowBody: { flex: 1, minWidth: 0, justifyContent: "center" as const, gap: 1 },
  swatch: { width: 8, height: 8, borderRadius: radius.xs, flexShrink: 0, marginHorizontal: 2 },
  panel: { gap: space.lg },
  card: {
    padding: space.xs,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
  },
  cardHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, paddingLeft: space.sm, minHeight: 32 },
  cardEmpty: { paddingHorizontal: space.sm, paddingBottom: space.sm, lineHeight: 18 },
};
