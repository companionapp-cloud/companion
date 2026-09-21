import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Badge, Button, Icon, Input, Spinner, Text, colors, radius, space } from "@companion/design-system";
import { EXPORT_CHANGED_EVENT, type ExportCapabilities, type ExportDestination, type ExportFolderConfig, type ExportSchedule } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { ConfirmDialog, useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { timeAgo } from "./NotificationRow";
import { CheckBox, Segmented, SettingsField, SettingsNote } from "./settingsUi";
import { canPickExportFolder, onScheduledExportRequest, pickExportFolder, takeScheduledExportRequest } from "./export/scheduling";

const SCHEDULES: { value: ExportSchedule; label: string }[] = [
  { value: "changes", label: "On changes" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "manual", label: "Manually" },
];

const SCHEDULE_WORDS: Record<ExportSchedule, string> = {
  changes: "when things change",
  hourly: "every hour",
  daily: "every day",
  weekly: "every week",
  manual: "only when asked",
};

type Editing = { destination?: ExportDestination } | null;

/** Settings › Export: keep a copy of the workspace in a folder, on a schedule — notes and tasks
 *  as markdown with front matter, canvases as JSON. The folder can sit in iCloud Drive, Dropbox
 *  and the like. It is one-way: a folder has no history and no way to say what was changed or
 *  deleted on purpose, so nothing is read back from it (two-way lives in Settings › Sync › Git;
 *  bringing files in is Settings › Import). The core does the exporting (core/export); the
 *  destinations belong to this device. Also reached from the desktop's File › Export menu. */
export function ExportSettings() {
  const { core, exports } = useCore();
  const [capabilities, setCapabilities] = useState<ExportCapabilities | null>(null);
  const [destinations, setDestinations] = useState<ExportDestination[]>([]);
  const [editing, setEditing] = useState<Editing>(null);

  const refresh = useCallback(() => {
    void exports
      .list()
      .then((all) => setDestinations(all.filter((d) => d.kind === "folder")))
      .catch(() => setDestinations([]));
  }, [exports]);
  useEffect(() => {
    void exports.capabilities().then(setCapabilities).catch(() => setCapabilities({ folder: false, git: false }));
    refresh();
    return core.on(EXPORT_CHANGED_EVENT, refresh);
  }, [core, exports, refresh]);

  // File › Export › Schedule … Exports lands here with a kind to start on.
  useEffect(() => {
    const take = () => {
      if (takeScheduledExportRequest("folder")) setEditing({});
    };
    take();
    return onScheduledExportRequest(take);
  }, []);

  if (!capabilities) return <Spinner label="Loading…" />;
  if (!capabilities.folder) {
    return (
      <View style={styles.page}>
        <SettingsNote tone="secondary">
          Scheduled exports run in the Companion desktop app, which can write to a folder and stay running to keep it up to
          date. Set them up there under Settings › Export.
        </SettingsNote>
        <SettingsNote>To save a single note, task or canvas from here, open it and use its Export button.</SettingsNote>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <View style={styles.section}>
        <View style={styles.head}>
          <Text variant="eyebrow" tone="quaternary">
            Filesystem exports
          </Text>
          <SettingsNote>
            Keep a folder of plain files up to date: notes and tasks as Markdown, canvases as JSON, the files they embed in an
            Attachments folder — filed by area and project.
            Put the folder in iCloud Drive, Dropbox or another synced drive to have a copy off this computer.
          </SettingsNote>
        </View>
        {destinations.map((d) => (
          <DestinationRow key={d.id} destination={d} onRun={() => void exports.run(d.id)} onEdit={() => setEditing({ destination: d })} />
        ))}
        <View style={styles.buttonRow}>
          <Button label="Schedule filesystem export…" variant="secondary" onPress={() => setEditing({})} />
        </View>
      </View>
      <SettingsNote>
        Exports are plain, readable files — that is the point of them — so they are not protected by Companion’s end-to-end
        encryption: anyone who can read the folder can read what’s in it. They are one-way: changes made to the files don’t
        come back into Companion. For that, sync with a Git repository under Settings › Sync, or bring files in once under
        Settings › Import. Exports are set up per device, and run while Companion is open or in the menu bar.
      </SettingsNote>
      {editing ? <DestinationDialog destination={editing.destination} onClose={() => setEditing(null)} /> : null}
    </View>
  );
}

function statusOf(d: ExportDestination): { text: string; tone: "tertiary" | "danger" } {
  if (d.running) return { text: "Exporting…", tone: "tertiary" };
  if (d.lastError) return { text: d.lastError, tone: "danger" };
  if (!d.lastSuccessAt) return { text: d.enabled ? "Not exported yet" : "Paused", tone: "tertiary" };
  const s = d.lastSummary;
  const counts = s
    ? [
        s.added && `${s.added} added`,
        s.updated && `${s.updated} updated`,
        s.removed && `${s.removed} removed`,
        s.waiting && `${s.waiting} ${s.waiting === 1 ? "attachment" : "attachments"} still downloading`,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  return { text: `Exported ${timeAgo(d.lastSuccessAt)}${counts ? ` · ${counts}` : " · up to date"}`, tone: "tertiary" };
}

function DestinationRow({ destination: d, onRun, onEdit }: { destination: ExportDestination; onRun: () => void; onEdit: () => void }) {
  const where = (d.config as ExportFolderConfig).path;
  const status = statusOf(d);
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Icon name="folder" size={13} color={colors.textTertiary} />
        <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
          {d.name}
        </Text>
        {!d.enabled ? <Badge tone="neutral" label="paused" /> : null}
        <View style={{ flex: 1 }} />
        <Button label={d.running ? "Exporting…" : "Export now"} variant="ghost" size="sm" disabled={d.running} onPress={onRun} />
        <Button label="Edit" variant="ghost" size="sm" onPress={onEdit} />
      </View>
      <Text variant="mono" tone="tertiary" numberOfLines={1}>
        {where}
      </Text>
      <Text variant="caption" tone={status.tone} numberOfLines={3}>
        {d.enabled ? `Exports ${SCHEDULE_WORDS[d.schedule]}` : "Paused"} · {status.text}
      </Text>
    </View>
  );
}

function DestinationDialog({ destination, onClose }: { destination?: ExportDestination; onClose: () => void }) {
  const { exports } = useCore();
  const [name, setName] = useState(destination?.name ?? "");
  const [schedule, setSchedule] = useState<ExportSchedule>(destination?.schedule ?? "changes");
  const [enabled, setEnabled] = useState(destination?.enabled ?? true);
  const [path, setPath] = useState((destination?.config as ExportFolderConfig | undefined)?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const choose = async () => {
    try {
      const picked = await pickExportFolder("export");
      if (picked) setPath(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (busy) return;
    if (!path) return setError("Choose a folder to export to.");
    setBusy(true);
    setError(null);
    try {
      await exports.save({ id: destination?.id, kind: "folder", name: name.trim(), schedule, enabled, path });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const hints = useDialogKeys({ onEnter: () => void save(), onEscape: busy ? undefined : onClose });

  if (confirmDelete && destination) {
    return (
      <ConfirmDialog
        title="Stop this export?"
        message={`Companion forgets “${destination.name}” and stops exporting to it. The files already in the folder stay where they are.`}
        confirmLabel="Stop exporting"
        onConfirm={async () => {
          await exports.remove(destination.id);
          onClose();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    );
  }

  return (
    <Dialog
      title={`${destination ? "Edit" : "Schedule a"} filesystem export`}
      width={480}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          {destination ? <Button label="Stop exporting…" variant="danger" onPress={() => setConfirmDelete(true)} /> : null}
          <View style={{ flex: 1 }} />
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          <Button label={busy ? "Saving…" : destination ? "Save" : "Start exporting"} kbd={hints ? "⏎" : undefined} disabled={busy} onPress={() => void save()} />
        </>
      }
    >
      <SettingsField label="Folder" help="An empty folder is best: Companion replaces files it finds with the same names, and only ever deletes files it wrote.">
        <View style={styles.pathRow}>
          <View style={styles.path}>
            <Text variant="mono" tone={path ? "default" : "quaternary"} numberOfLines={1}>
              {path || "No folder chosen"}
            </Text>
          </View>
          <Button label="Choose…" variant="secondary" disabled={!canPickExportFolder()} onPress={() => void choose()} />
        </View>
      </SettingsField>
      <SettingsField label="Name" help="Optional. The folder’s name otherwise.">
        <Input value={name} onChangeText={setName} />
      </SettingsField>
      <SettingsField label="Export" help={schedule === "changes" ? "About a minute after you stop making changes." : schedule === "manual" ? "Only when you choose Export now." : undefined}>
        <Segmented fill options={SCHEDULES} value={schedule} onChange={setSchedule} />
      </SettingsField>
      {destination ? <CheckBox checked={enabled} onPress={() => setEnabled((v) => !v)} label="Keep exporting on this schedule" /> : null}
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </Dialog>
  );
}

const styles = {
  page: { gap: space.xxl },
  section: { gap: space.md },
  head: { gap: space.xs },
  buttonRow: { flexDirection: "row" as const },
  row: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    paddingLeft: space.ml,
    paddingRight: space.xs,
    paddingTop: space.xs,
    paddingBottom: space.sm,
    gap: 2,
  },
  rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  pathRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  path: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center" as const,
    height: 26,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken,
  },
};
