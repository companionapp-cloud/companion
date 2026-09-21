import { useEffect, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { CalendarFeed, CalendarItem, CalendarRepeat } from "@companion/core-bridge";
import { Button, Icon, IconButton, Input, Text, TextField, colors, radius, space } from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";
import { useCore } from "./CoreContext";
import { useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { DateField } from "./DateField";
import { CheckBox, Segmented, SettingsField, SettingsNote } from "./settingsUi";

export type EventEditorTarget =
  /** Create a new event starting at `startsAt` (a local instant), optionally all-day, its
   *  title seeded with what was already typed (the agenda's palette). */
  | { mode: "create"; startsAt: Date; endsAt?: Date; allDay?: boolean; title?: string }
  /** Edit an existing occurrence from `calendar.range`. */
  | { mode: "edit"; item: CalendarItem };

// ---- local date/time strings ---------------------------------------------------------------
// The form works in the strings the date and time fields speak — "2026-09-21", "14:30", both in
// LOCAL terms — and only becomes instants on save. All-day events travel as a date-only marker
// at midnight UTC with an exclusive end (the day AFTER the last), the shape iCalendar uses and
// `calendar.range` returns; the form shows the inclusive last day, which is how people think.

const pad = (n: number) => String(n).padStart(2, "0");
const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDate = (date: string, time = "00:00") => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
};
const addDays = (date: string, n: number) => {
  const d = localDate(date);
  return dateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
const daysBetween = (a: string, b: string) => Math.round((localDate(b).getTime() - localDate(a).getTime()) / 86_400_000);
/** "2026-09-21" → the all-day marker "2026-09-21T00:00:00.000Z". */
const marker = (date: string) => `${date}T00:00:00.000Z`;

interface Times {
  allDay: boolean;
  date: string;
  /** All-day: the inclusive last day. Timed: the day the event ends (usually `date`). */
  endDate: string;
  start: string;
  end: string;
}

function initialTimes(target: EventEditorTarget): Times {
  if (target.mode === "edit" && target.item.allDay) {
    const date = target.item.startsAt.slice(0, 10);
    const last = target.item.endsAt ? addDays(target.item.endsAt.slice(0, 10), -1) : date;
    return { allDay: true, date, endDate: last < date ? date : last, start: "09:00", end: "10:00" };
  }
  const start = target.mode === "edit" ? new Date(target.item.startsAt) : target.startsAt;
  const given = target.mode === "edit" ? target.item.endsAt : target.endsAt;
  const end = given ? new Date(given) : new Date(start.getTime() + 60 * 60_000);
  const allDay = target.mode === "create" && !!target.allDay;
  return { allDay, date: dateStr(start), endDate: allDay ? dateStr(start) : dateStr(end), start: timeStr(start), end: timeStr(end) };
}

const UNIT: Record<string, [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};

/** Create or edit an event in a CalDAV calendar (PLAN-caldav.md §6). Saving only changes local
 *  rows — the event shows at once, marked pending — and the provider is updated in the
 *  background, from this device or (on web) one of the user's native ones. */
export function EventEditorDialog({
  target,
  feeds,
  onClose,
  onSaved,
}: {
  target: EventEditorTarget;
  /** The calendars a new event may go in (a project's calendar offers only its own); every
   *  writable calendar when omitted. */
  feeds?: CalendarFeed[];
  onClose: () => void;
  /** Called after a successful save or delete, before `onClose` — for a host holding a snapshot
   *  of the event (the mobile detail screen) that is now stale. */
  onSaved?: () => void;
}) {
  const { writableFeeds: allWritable, createEvent, updateEvent, removeEvent } = useCalendar();
  const writableFeeds = feeds ?? allWritable;
  const { calendar } = useCore();
  const editing = target.mode === "edit" ? target.item : null;
  const recurring = !!editing?.recurring;

  const [title, setTitle] = useState(editing?.title ?? (target.mode === "create" ? target.title : undefined) ?? "");
  const [feedId, setFeedId] = useState<string>(editing?.feedId ?? writableFeeds[0]?.id ?? "");
  const [times, setTimes] = useState<Times>(() => initialTimes(target));
  const [timesTouched, setTimesTouched] = useState(false);
  const [location, setLocation] = useState(editing?.location ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  // The repeat rule is not part of a calendar item; it is fetched when an event is opened.
  const [repeat, setRepeat] = useState<CalendarRepeat>({ freq: "none" });
  const [repeatTouched, setRepeatTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Deleting a repeating event asks which: this occurrence or the series.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const sourceId = editing?.sourceId;
  useEffect(() => {
    if (!sourceId) return;
    let alive = true;
    void calendar.events
      .get(sourceId)
      .then((res) => {
        if (alive && res.repeat) setRepeat(res.repeat);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [calendar, sourceId]);

  const patchTimes = (patch: Partial<Times>) => {
    setTimesTouched(true);
    setTimes((prev) => {
      const next = { ...prev, ...patch };
      // Moving the first day carries the last day with it, keeping the length.
      if (patch.date && !patch.endDate) next.endDate = addDays(patch.date, daysBetween(prev.date, prev.endDate));
      // Moving the start time carries the end with it, keeping the duration.
      if (patch.start && !patch.end && !next.allDay) {
        const len = localDate(prev.endDate, prev.end).getTime() - localDate(prev.date, prev.start).getTime();
        const end = new Date(localDate(next.date, next.start).getTime() + Math.max(len, 5 * 60_000));
        next.end = timeStr(end);
        next.endDate = dateStr(end);
      }
      // An end time at or before the start means "the next day" (a late shift, a red-eye).
      if (patch.end && !next.allDay) next.endDate = next.end <= next.start ? addDays(next.date, 1) : next.date;
      if (next.endDate < next.date) next.endDate = next.date;
      return next;
    });
  };

  const patchRepeat = (patch: Partial<CalendarRepeat>) => {
    setRepeatTouched(true);
    // Choosing anything replaces a custom rule with a simple one.
    setRepeat((prev) => ({ ...prev, ...patch, custom: false }));
  };

  const save = async () => {
    if (busy) return;
    if (!title.trim()) return setError("A title is required.");
    if (!editing && !feedId) return setError("Choose a calendar.");
    const startsAt = times.allDay ? marker(times.date) : localDate(times.date, times.start).toISOString();
    const endsAt = times.allDay ? marker(addDays(times.endDate, 1)) : localDate(times.endDate, times.end).toISOString();
    if (endsAt <= startsAt) return setError("The event must end after it starts.");
    if (repeat.freq !== "none" && repeat.until && repeat.until.slice(0, 10) < times.date) {
      return setError("The repeat can’t end before the event starts.");
    }
    const rule: CalendarRepeat = { freq: repeat.freq, interval: Math.max(1, repeat.interval ?? 1), until: repeat.until ?? undefined };
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await updateEvent(editing.sourceId, {
          title: title.trim(),
          location,
          description,
          // Only send what the user actually changed: an untouched event keeps the exact start
          // (time zone included) and the exact rule its own calendar app wrote.
          ...(timesTouched ? { startsAt, endsAt, allDay: times.allDay } : {}),
          ...(repeatTouched ? { repeat: rule } : {}),
        });
      } else {
        await createEvent({
          feedId,
          title: title.trim(),
          startsAt,
          endsAt,
          allDay: times.allDay,
          location: location || null,
          description: description || null,
          repeat: rule.freq === "none" ? null : rule,
        });
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const remove = async (scope: "occurrence" | "series") => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      await removeEvent(editing.sourceId, scope);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const hints = useDialogKeys({ onEnter: confirmDelete ? undefined : () => void save(), onEscape: busy ? undefined : onClose });

  if (!editing && writableFeeds.length === 0) {
    return (
      <Dialog title="No calendar to add to" onClose={onClose} footer={<Button label="OK" onPress={onClose} />}>
        <Text tone="secondary" style={styles.message}>
          Events can be created in calendars from an account (iCloud, Google, Fastmail, Nextcloud…). Subscriptions are
          read-only. Add an account in Settings › Calendar.
        </Text>
      </Dialog>
    );
  }

  const overnight = !times.allDay && times.endDate !== times.date;
  const unit = UNIT[repeat.freq];
  const interval = Math.max(1, repeat.interval ?? 1);

  const footer = (
    <>
      {confirmDelete ? (
        <>
          <Button label="Cancel" variant="ghost" onPress={() => setConfirmDelete(false)} />
          <Button label="This event only" variant="secondary" disabled={busy} onPress={() => void remove("occurrence")} />
          <Button label="All events" variant="danger" disabled={busy} onPress={() => void remove("series")} />
        </>
      ) : (
        <>
          {editing ? (
            <View style={styles.leading}>
              <Button
                label="Delete"
                variant="ghost"
                disabled={busy}
                onPress={() => (recurring ? setConfirmDelete(true) : void remove("series"))}
              />
            </View>
          ) : null}
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          <Button label={editing ? "Save" : "Add event"} kbd={hints ? "⏎" : undefined} disabled={busy} onPress={() => void save()} />
        </>
      )}
    </>
  );

  return (
    <Dialog title={editing ? "Edit event" : "New event"} width={480} onClose={busy ? undefined : onClose} footer={footer}>
      <Input autoFocus value={title} onChangeText={setTitle} placeholder="Title" />

      {!editing && writableFeeds.length > 1 ? (
        <SettingsField label="Calendar">
          <View style={styles.wrapRow}>
            {writableFeeds.map((f) => (
              <FeedChip key={f.id} feed={f} selected={f.id === feedId} onPress={() => setFeedId(f.id)} />
            ))}
          </View>
        </SettingsField>
      ) : null}

      {/* When: a date, then either two times or a last day. */}
      <View style={styles.timeRow}>
        <Labeled label={times.allDay ? "First day" : "Date"} flex={3}>
          <DateField kind="date" ariaLabel="Date" value={times.date} onChange={(date) => patchTimes({ date })} />
        </Labeled>
        {times.allDay ? (
          <Labeled label="Last day" flex={3}>
            <DateField kind="date" ariaLabel="Last day" value={times.endDate} onChange={(endDate) => patchTimes({ endDate })} />
          </Labeled>
        ) : (
          <>
            <Labeled label="Starts" flex={2}>
              <DateField kind="time" ariaLabel="Start time" value={times.start} onChange={(start) => patchTimes({ start })} />
            </Labeled>
            <Labeled label={overnight ? "Ends (next day)" : "Ends"} flex={2}>
              <DateField kind="time" ariaLabel="End time" value={times.end} onChange={(end) => patchTimes({ end })} />
            </Labeled>
          </>
        )}
      </View>
      {/* A repeating event can't change kind (the core refuses it); don't offer what will fail. */}
      {recurring && repeat.freq !== "none" ? null : (
        <CheckBox checked={times.allDay} onPress={() => patchTimes({ allDay: !times.allDay, endDate: times.date })} label="All day" />
      )}

      <SettingsField label="Repeat">
        <Segmented
          fill
          options={[
            { value: "none", label: "Never" },
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
            { value: "yearly", label: "Yearly" },
            ...(repeat.custom ? [{ value: "custom", label: "Custom" }] : []),
          ]}
          value={repeat.custom ? "custom" : repeat.freq}
          onChange={(freq) => {
            if (freq !== "custom") patchRepeat({ freq: freq as CalendarRepeat["freq"] });
          }}
        />
        {repeat.custom ? (
          <SettingsNote>
            This event repeats on a custom pattern set in another app. It’s kept as it is unless you pick one of the
            options above, which replaces it.
          </SettingsNote>
        ) : unit ? (
          <View style={styles.repeatRow}>
            <Text variant="caption" tone="secondary">
              Every
            </Text>
            <View style={styles.intervalBox}>
              <Input
                size="sm"
                mono
                value={String(interval)}
                onChangeText={(t) => patchRepeat({ interval: Math.min(99, Math.max(1, parseInt(t.replace(/\D/g, ""), 10) || 1)) })}
              />
            </View>
            <Text variant="caption" tone="secondary">
              {interval === 1 ? unit[0] : unit[1]}, until
            </Text>
            <View style={styles.untilBox}>
              {repeat.until ? (
                <DateField kind="date" ariaLabel="Repeat until" value={repeat.until.slice(0, 10)} onChange={(d) => patchRepeat({ until: marker(d) })} />
              ) : (
                <Button variant="ghost" size="sm" label="forever — set an end" onPress={() => patchRepeat({ until: marker(addDays(times.date, 90)) })} />
              )}
            </View>
            {repeat.until ? (
              <IconButton label="Repeat forever" size="sm" onPress={() => patchRepeat({ until: null })}>
                <Icon name="close" size={12} color={colors.textTertiary} />
              </IconButton>
            ) : null}
          </View>
        ) : null}
      </SettingsField>
      {recurring ? <SettingsNote>This is a repeating event. Changes here apply to every occurrence.</SettingsNote> : null}

      <Input value={location} onChangeText={setLocation} placeholder="Location" />
      <View style={styles.textArea}>
        <TextField multiline value={description} onChangeText={setDescription} placeholder="Notes" />
      </View>

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}

    </Dialog>
  );
}

function Labeled({ label, flex, children }: { label: string; flex: number; children: ReactNode }) {
  return (
    <View style={[styles.timeCell, { flex }]}>
      <Text variant="caption" tone="tertiary" numberOfLines={1}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function FeedChip({ feed, selected, onPress }: { feed: CalendarFeed; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} aria-label={feed.name} style={[styles.chip, selected ? styles.chipOn : null]}>
      <View style={[styles.swatch, { backgroundColor: feed.color ?? colors.borderStrong }]} />
      <Text variant="caption" tone={selected ? "default" : "secondary"} numberOfLines={1}>
        {feed.name}
      </Text>
    </Pressable>
  );
}

const styles = {
  message: { lineHeight: 19 },
  timeRow: { flexDirection: "row" as const, gap: space.md },
  timeCell: { minWidth: 0, gap: space.xs },
  wrapRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.sm },
  repeatRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, flexWrap: "wrap" as const },
  intervalBox: { width: 44 },
  untilBox: { minWidth: 140 },
  // A bordered box around the design system's borderless multi-line field, sized for a few
  // lines of notes; longer text scrolls inside it.
  textArea: {
    height: 88,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceCard,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  chip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    maxWidth: "100%" as const,
  },
  chipOn: { borderColor: colors.borderFocus, backgroundColor: colors.surfaceActive },
  swatch: { width: 8, height: 8, borderRadius: radius.xs, flexShrink: 0 },
  leading: { flex: 1, flexDirection: "row" as const },
};
