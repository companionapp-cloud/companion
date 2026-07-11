import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Icon, Input, Text, colors, radius, space } from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";
import { SettingsField } from "./SyncSettings";
import { canPickIcsFile, pickIcsFile } from "./icsFile";

// A small swatch palette for feeds; a feed's color tints its events in the calendar.
const SWATCHES = ["#6366f1", "#059669", "#d97706", "#dc2626", "#0891b2", "#7c3aed"];

type Source = "url" | "file";

/** Calendar settings (PLAN §6.7): add ICS feeds by subscription URL or by uploading an .ics
 *  file, and remove existing ones. Either way the server clones the events; clients only
 *  manage the feed rows. Self-contained so the same section renders on the desktop settings
 *  page and the mobile settings stack. */
export function CalendarSettings() {
  const { feeds, createFeed, removeFeed } = useCalendar();
  const [source, setSource] = useState<Source>("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  // For an uploaded file: its raw ICS text plus the picked filename (shown as confirmation).
  const [icsText, setIcsText] = useState<string | null>(null);
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [color, setColor] = useState(SWATCHES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setUrl("");
    setIcsText(null);
    setFileLabel(null);
  };

  const chooseFile = async () => {
    setError(null);
    const file = await pickIcsFile();
    if (!file) return;
    setIcsText(file.text);
    setFileLabel(file.name);
    // Prefill the feed name from the filename (minus extension) if empty.
    if (!name.trim()) setName(file.name.replace(/\.ics$/i, ""));
  };

  const add = async () => {
    if (!name.trim()) {
      setError("A name is required.");
      return;
    }
    if (source === "url" && !url.trim()) {
      setError("Enter the ICS URL.");
      return;
    }
    if (source === "file" && !icsText) {
      setError("Choose an .ics file to upload.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createFeed({
        name: name.trim(),
        url: source === "url" ? url.trim() : "",
        icsText: source === "file" ? icsText : null,
        color,
      });
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.xl }}>
      {feeds.length > 0 ? (
        <View style={{ gap: space.sm }}>
          {feeds.map((f) => (
            <View key={f.id} style={styles.feedRow}>
              <View style={[styles.swatch, { backgroundColor: f.color ?? colors.gray400 }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontWeight: "600" }}>
                  {f.name}
                </Text>
                <Text tone="tertiary" variant="caption" numberOfLines={1}>
                  {f.url ? f.url : "Uploaded .ics file"}
                </Text>
              </View>
              <Pressable onPress={() => void removeFeed(f.id)} aria-label={`Remove ${f.name}`} style={styles.remove}>
                <Icon name="trash" size={16} color={colors.textTertiary} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : (
        <Text tone="tertiary" variant="caption">
          No calendars yet. Subscribe to an ICS URL (Google Calendar, Fastmail, a holidays feed) or
          upload an .ics file below.
        </Text>
      )}

      <View style={{ gap: space.lg }}>
        {/* Source toggle: URL vs uploaded file. */}
        <View style={styles.segmented}>
          <SegmentButton label="Subscribe by URL" active={source === "url"} onPress={() => setSource("url")} />
          {canPickIcsFile() ? (
            <SegmentButton label="Upload .ics file" active={source === "file"} onPress={() => setSource("file")} />
          ) : null}
        </View>

        <SettingsField label="Name">
          <Input value={name} onChangeText={setName} placeholder="Work" autoCapitalize="none" />
        </SettingsField>

        {source === "url" ? (
          <SettingsField label="ICS URL">
            <Input value={url} onChangeText={setUrl} placeholder="https://…/basic.ics" autoCapitalize="none" />
          </SettingsField>
        ) : (
          <SettingsField label="File">
            <View style={styles.fileRow}>
              <Button variant="secondary" label={icsText ? "Replace file" : "Choose .ics file"} onPress={chooseFile} />
              {fileLabel ? (
                <Text tone="secondary" variant="caption" numberOfLines={1} style={{ flex: 1 }}>
                  {fileLabel}
                </Text>
              ) : null}
            </View>
          </SettingsField>
        )}

        <SettingsField label="Color">
          <View style={styles.swatchRow}>
            {SWATCHES.map((c) => (
              <Pressable
                key={c}
                onPress={() => setColor(c)}
                aria-label={`Color ${c}`}
                style={[styles.swatchPick, { backgroundColor: c }, color === c ? styles.swatchActive : null]}
              />
            ))}
          </View>
        </SettingsField>

        {error ? (
          <Text tone="danger" variant="caption">
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row" }}>
          <Button label={busy ? "Adding…" : "Add calendar"} onPress={add} disabled={busy} />
        </View>
        <Text tone="tertiary" variant="caption">
          The server parses each calendar and syncs its events to your devices; URL feeds refresh every
          few minutes.
        </Text>
      </View>
    </View>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.segment, active ? styles.segmentActive : null]}>
      <Text variant="caption" style={{ color: active ? colors.onAccent : colors.textSecondary, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = {
  feedRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceApp,
  },
  swatch: { width: 12, height: 12, borderRadius: radius.full, flexShrink: 0 },
  remove: { padding: space.xs },
  segmented: { flexDirection: "row" as const, gap: space.xs },
  segment: { paddingVertical: space.xs, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.surfaceApp },
  segmentActive: { backgroundColor: colors.accent },
  fileRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
  swatchRow: { flexDirection: "row" as const, gap: space.sm },
  swatchPick: { width: 24, height: 24, borderRadius: radius.full },
  swatchActive: { borderWidth: 2, borderColor: colors.textPrimary },
};
