import { useState } from "react";
import { View } from "react-native";
import { Button, Divider, Icon, IconButton, Input, Text, colors, icon, radius, row, space, swatches, useDensity } from "@companion/design-system";
import { CalendarAccountsSettings } from "./CalendarAccountsSettings";
import { useCalendar } from "./CalendarProvider";
import { useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { Segmented, SettingsField, SettingsNote, SwatchPicker } from "./settingsUi";
import { canPickIcsFile, pickIcsFile } from "./icsFile";

// A feed's color tints its events in the calendar; pickers offer the shared swatches.
const DEFAULT_COLOR = swatches[4];

type Source = "url" | "file";

/** Calendar settings (PLAN §6.7, PLAN-caldav.md): two sections, each a list with one button under
 *  it that opens its add flow in a dialog.
 *
 *   - Accounts: CalDAV logins — two-way, their events can be created and edited.
 *   - Subscriptions: an ICS URL or an uploaded .ics file — read-only.
 *
 *  Either way this device fetches the calendar itself and syncs the events encrypted. Self-contained
 *  so the same section renders on the desktop settings page and the mobile settings stack. */
export function CalendarSettings() {
  const { feeds: allFeeds, removeFeed } = useCalendar();
  // An account's calendars are listed (and removed) with their account.
  const feeds = allFeeds.filter((f) => f.kind !== "caldav");
  const touch = useDensity() === "touch";
  const [adding, setAdding] = useState(false);

  return (
    <View style={styles.page}>
      <CalendarAccountsSettings />

      <Divider />

      <View style={styles.section}>
        <View style={styles.head}>
          <Text variant="eyebrow" tone="quaternary">
            Subscriptions{feeds.length > 0 ? ` · ${feeds.length}` : ""}
          </Text>
          <SettingsNote>Read-only calendars from a link or a file: a shared Google calendar, public holidays, a team schedule.</SettingsNote>
        </View>

        {feeds.length > 0 ? (
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
        ) : null}

        <View style={styles.buttonRow}>
          <Button variant="secondary" label="Add subscription" onPress={() => setAdding(true)} />
        </View>
      </View>

      {adding ? <AddSubscriptionDialog onClose={() => setAdding(false)} /> : null}
    </View>
  );
}

/** The add-subscription flow: a URL to subscribe to, or an .ics file to upload, plus a name and
 *  a color. */
function AddSubscriptionDialog({ onClose }: { onClose: () => void }) {
  const { createFeed } = useCalendar();
  const [source, setSource] = useState<Source>("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  // For an uploaded file: its raw ICS text plus the picked filename (shown as confirmation).
  const [icsText, setIcsText] = useState<string | null>(null);
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseFile = async () => {
    setError(null);
    const file = await pickIcsFile();
    if (!file) return;
    setIcsText(file.text);
    setFileLabel(file.name);
    // Prefill the name from the filename (minus extension) if empty.
    if (!name.trim()) setName(file.name.replace(/\.ics$/i, ""));
  };

  const add = async () => {
    if (busy) return;
    if (!name.trim()) return setError("A name is required.");
    if (source === "url" && !url.trim()) return setError("Enter the ICS URL.");
    if (source === "file" && !icsText) return setError("Choose an .ics file to upload.");
    setBusy(true);
    setError(null);
    try {
      await createFeed({
        name: name.trim(),
        url: source === "url" ? url.trim() : "",
        icsText: source === "file" ? icsText : null,
        color,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const hints = useDialogKeys({ onEnter: () => void add(), onEscape: busy ? undefined : onClose });

  return (
    <Dialog
      title="Add a subscription"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          <Button label={busy ? "Adding…" : "Add subscription"} kbd={hints ? "⏎" : undefined} disabled={busy} onPress={() => void add()} />
        </>
      }
    >
      {canPickIcsFile() ? (
        <Segmented
          fill
          options={[
            { value: "url", label: "Subscribe by URL" },
            { value: "file", label: "Upload .ics file" },
          ]}
          value={source}
          onChange={setSource}
        />
      ) : null}

      {source === "url" ? (
        <SettingsField label="ICS URL" help="webcal:// links work too. Press refresh in the calendar to fetch changes.">
          <Input autoFocus mono value={url} onChangeText={setUrl} placeholder="https://…/basic.ics" autoCapitalize="none" />
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

      <SettingsField label="Name">
        <Input value={name} onChangeText={setName} placeholder="Holidays" autoCapitalize="none" />
      </SettingsField>

      <SettingsField label="Color">
        <SwatchPicker value={color} onChange={(c) => setColor(c ?? DEFAULT_COLOR)} />
      </SettingsField>

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      <SettingsNote>The calendar is fetched on this device and its events sync to your others, encrypted.</SettingsNote>
    </Dialog>
  );
}

const styles = {
  page: { gap: space.xl },
  section: { gap: space.lg },
  head: { gap: space.xs },
  buttonRow: { flexDirection: "row" as const },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  feedRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, paddingLeft: space.ml, paddingRight: space.xs },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  swatch: { width: 8, height: 8, borderRadius: radius.xs, flexShrink: 0 },
  feedName: { flexShrink: 0, maxWidth: "50%" as const },
  feedUrl: { flex: 1, minWidth: 0, textAlign: "right" as const },
  fileRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
};
