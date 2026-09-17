import { useState } from "react";
import { View } from "react-native";
import { Button, Divider, Icon, IconButton, Input, Text, colors, icon, radius, row, space, swatches, useDensity } from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";
import { Segmented, SettingsField, SettingsNote, SwatchPicker } from "./settingsUi";
import { canPickIcsFile, pickIcsFile } from "./icsFile";

// A feed's color tints its events in the calendar; pickers offer the shared swatches.
const DEFAULT_COLOR = swatches[4];

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
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
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

  const touch = useDensity() === "touch";

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
    <View style={styles.section}>
      {feeds.length > 0 ? (
        <View style={styles.stack}>
          <Text variant="eyebrow" tone="quaternary">
            Calendars · {feeds.length}
          </Text>
          <View style={styles.list}>
            {feeds.map((f, i) => (
              <View key={f.id} style={[styles.feedRow, { minHeight: touch ? row.touch : 32 }, i === feeds.length - 1 ? null : styles.rowDivider]}>
                <View style={[styles.swatch, { backgroundColor: f.color ?? colors.borderStrong }]} />
                <Text variant="label" numberOfLines={1} style={styles.feedName}>
                  {f.name}
                </Text>
                <Text variant="mono" tone="quaternary" numberOfLines={1} style={styles.feedUrl}>
                  {f.url ? f.url : "uploaded .ics file"}
                </Text>
                <IconButton label={`Remove ${f.name}`} size={touch ? undefined : "sm"} onPress={() => void removeFeed(f.id)}>
                  <Icon name="trash" size={touch ? icon.lg : 13} color={colors.textTertiary} />
                </IconButton>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <SettingsNote>
          No calendars yet. Subscribe to an ICS URL (Google Calendar, Fastmail, a holidays feed) or upload an .ics file
          below.
        </SettingsNote>
      )}

      <Divider />

      <Text variant="eyebrow" tone="quaternary">
        Add a calendar
      </Text>
      {/* Source toggle: URL vs uploaded file. */}
      {canPickIcsFile() ? (
        <Segmented
          options={[
            { value: "url", label: "Subscribe by URL" },
            { value: "file", label: "Upload .ics file" },
          ]}
          value={source}
          onChange={setSource}
        />
      ) : null}

      <SettingsField label="Name">
        <View style={styles.control}>
          <Input value={name} onChangeText={setName} placeholder="Work" autoCapitalize="none" />
        </View>
      </SettingsField>

      {source === "url" ? (
        <SettingsField label="ICS URL" help="URL feeds refresh every few minutes.">
          <Input mono value={url} onChangeText={setUrl} placeholder="https://…/basic.ics" autoCapitalize="none" />
        </SettingsField>
      ) : (
        <SettingsField label="File">
          <View style={styles.fileRow}>
            <Button variant="secondary" label={icsText ? "Replace file" : "Choose .ics file"} onPress={chooseFile} />
            {fileLabel ? (
              <Text variant="mono" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>
                {fileLabel}
              </Text>
            ) : null}
          </View>
        </SettingsField>
      )}

      <SettingsField label="Color">
        <SwatchPicker value={color} onChange={(c) => setColor(c ?? DEFAULT_COLOR)} />
      </SettingsField>

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      <View style={{ flexDirection: "row" }}>
        <Button label={busy ? "Adding…" : "Add calendar"} onPress={add} disabled={busy} />
      </View>
      <SettingsNote>The server parses each calendar and syncs its events to your devices.</SettingsNote>
    </View>
  );
}

const styles = {
  section: { gap: space.xl },
  stack: { gap: space.md },
  control: { width: "100%" as const, maxWidth: 320 },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  feedRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, paddingLeft: space.ml, paddingRight: space.xs },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  swatch: { width: 8, height: 8, borderRadius: radius.xs, flexShrink: 0 },
  feedName: { flexShrink: 0, maxWidth: "50%" as const },
  feedUrl: { flex: 1, minWidth: 0, textAlign: "right" as const },
  fileRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
};
