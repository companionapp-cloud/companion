import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { CalendarItem } from "@companion/core-bridge";
import { Icon, IconButton, Input, ListRow, Text, colors, radius, shadow, space } from "@companion/design-system";
import { useCalendar } from "../CalendarProvider";
import { formatWhen } from "../CalendarItemInfo";

// How far around today the picker looks for events: a month back, six months ahead.
const PAST_DAYS = 30;
const FUTURE_DAYS = 180;

/** A search dialog for choosing a calendar event to embed on a canvas, over the same
 *  merged range query the calendar screens use, narrowed to feed events. */
export function EventPicker({ onPick, onClose }: { onPick: (item: CalendarItem) => void; onClose: () => void }) {
  const { range, revision } = useCalendar();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CalendarItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const from = new Date(now.getTime() - PAST_DAYS * 86400e3).toISOString();
    const to = new Date(now.getTime() + FUTURE_DAYS * 86400e3).toISOString();
    void range(from, to).then((rows) => {
      if (!cancelled) setItems((rows ?? []).filter((r) => r.kind === "event"));
    });
    return () => {
      cancelled = true;
    };
  }, [range, revision]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? items.filter((i) => i.title.toLowerCase().includes(q)) : items;
    // Upcoming first, then the recent past.
    const now = Date.now();
    const upcoming = base.filter((i) => new Date(i.startsAt).getTime() >= now);
    const past = base.filter((i) => new Date(i.startsAt).getTime() < now).reverse();
    return [...upcoming, ...past].slice(0, 60);
  }, [items, query]);

  return (
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label="Close" />
      <View style={styles.card}>
        <View style={styles.header}>
          <Text variant="title">Add an event</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size="sm" onPress={onClose}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>
        <View style={styles.search}>
          <Input size="sm" autoFocus placeholder="Search events" value={query} onChangeText={setQuery} leadingIcon={<Icon name="search" size={15} color={colors.textTertiary} />} />
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {filtered.length ? (
            filtered.map((it) => (
              <ListRow key={it.id} icon={<Icon name="calendar" size={16} color={it.color ?? colors.textTertiary} />} title={it.title || "Untitled event"} subtitle={formatWhen(it)} onPress={() => onPick(it)} />
            ))
          ) : (
            <Text tone="tertiary" variant="caption" style={{ padding: space.lg, textAlign: "center" }}>
              {query ? "Nothing matches that." : "No events in the next six months. Subscribe to a calendar in Settings first."}
            </Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = {
  scrim: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, alignItems: "center" as const, justifyContent: "center" as const, zIndex: 50 },
  scrimFill: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(17,17,16,0.25)" },
  card: { width: 440, maxWidth: "92%" as const, maxHeight: "80%" as const, backgroundColor: colors.surfaceCard, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.borderSubtle, ...shadow.lg, overflow: "hidden" as const },
  header: { flexDirection: "row" as const, alignItems: "center" as const, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  search: { padding: space.md },
  body: { padding: space.sm, gap: 2 },
};
