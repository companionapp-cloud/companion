import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Badge, Button, Icon, Input, Spinner, Text, colors, radius, space } from "@companion/design-system";
import { EXPORT_CHANGED_EVENT, type ExportCapabilities, type ExportDestination, type ExportFolderConfig, type ExportSchedule } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";
import { ConfirmDialog, useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { timeAgo } from "./NotificationRow";
import { CheckBox, Segmented, SettingsField, SettingsNote } from "./settingsUi";
import { canPickExportFolder, onScheduledExportRequest, pickExportFolder, takeScheduledExportRequest } from "./export/scheduling";
import { OtherDeviceActions, OtherDeviceStatus, exporterName } from "./export/OtherDeviceExport";

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
type TakingOver = { destination: ExportDestination; path?: string } | null;

const pathOf = (d: ExportDestination): string => (d.config as ExportFolderConfig).path ?? "";

/** Settings › Export: keep a copy of the workspace in a folder, on a schedule — notes and tasks
 *  as markdown with front matter, canvases as JSON. The folder can sit in iCloud Drive, Dropbox
 *  and the like. It is one-way: a folder has no history and no way to say what was changed or
 *  deleted on purpose, so nothing is read back from it (two-way lives in Settings › Sync › Git;
 *  bringing files in is Settings › Import). The core does the exporting (core/export). Each
 *  export runs on the device whose disk the folder is on, and syncs: every device lists every
 *  export, and can pause it, remove it or (a desktop) take it over. Also reached from the
 *  desktop's File › Export menu. */
export function ExportSettings() {
  const { core, exports } = useCore();
  const [capabilities, setCapabilities] = useState<ExportCapabilities | null>(null);
  const [destinations, setDestinations] = useState<ExportDestination[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [takingOver, setTakingOver] = useState<TakingOver>(null);

  const refresh = useCallback(() => {
    void exports
      .list()
      .then((all) => setDestinations(all.filter((d) => d.kind === "folder")))
      .catch(() => setDestinations([]));
  }, [exports]);
  useEffect(() => {
    void exports.capabilities().then(setCapabilities).catch(() => setCapabilities({ folder: false, git: false }));
    refresh();
    const offExport = core.on(EXPORT_CHANGED_EVENT, refresh);
    // Another device's exports, and its changes to them, arrive with a server sync.
    const offData = core.on("data.changed", (payload) => {
      if (!(payload as { id?: string } | null)?.id) refresh();
    });
    return () => {
      offExport();
      offData();
    };
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
  const canRun = capabilities.folder;
  const others = destinations.filter((d) => !d.thisDevice);

  return (
    <View style={styles.page}>
      <View style={styles.section}>
        <View style={styles.head}>
          <Text variant="eyebrow" tone="quaternary">
            Filesystem exports
          </Text>
          <SettingsNote>Export your data to a folder on a schedule.</SettingsNote>
        </View>
        {destinations.map((d) =>
          d.thisDevice ? (
            <DestinationRow key={d.id} destination={d} onEdit={() => setEditing({ destination: d })} />
          ) : (
            <OtherDeviceRow key={d.id} destination={d} onTakeOver={canRun ? () => setTakingOver({ destination: d }) : undefined} />
          ),
        )}
        {canRun ? (
          <View style={styles.buttonRow}>
            <Button label="Schedule filesystem export…" variant="secondary" onPress={() => setEditing({})} />
          </View>
        ) : (
          <SettingsNote tone="secondary">Set up filesystem exports in the Companion desktop app.</SettingsNote>
        )}
      </View>
      <SettingsNote>Files synced with scheduled filesystem exports are not E2E encrypted.</SettingsNote>
      {editing ? (
        <DestinationDialog
          destination={editing.destination}
          others={others}
          onTakeOverInstead={(d, path) => {
            setEditing(null);
            setTakingOver({ destination: d, path });
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {takingOver ? <TakeOverDialog destination={takingOver.destination} initialPath={takingOver.path} onClose={() => setTakingOver(null)} /> : null}
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

/** An export this device runs. */
function DestinationRow({ destination: d, onEdit }: { destination: ExportDestination; onEdit: () => void }) {
  const { exports } = useCore();
  const sync = useSync();
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
        {d.enabled ? (
          <Button label={d.running ? "Exporting…" : "Export now"} variant="ghost" size="sm" disabled={d.running} onPress={() => void exports.run(d.id)} />
        ) : (
          <Button label="Resume" variant="ghost" size="sm" onPress={() => void exports.setEnabled(d.id, true).then(() => sync.trigger())} />
        )}
        <Button label="Edit" variant="ghost" size="sm" onPress={onEdit} />
      </View>
      <Text variant="mono" tone="tertiary" numberOfLines={1}>
        {pathOf(d)}
      </Text>
      <Text variant="caption" tone={status.tone} numberOfLines={3}>
        {d.enabled ? `Exports ${SCHEDULE_WORDS[d.schedule]}` : "Paused"} · {status.text}
      </Text>
    </View>
  );
}

/** An export another device runs, into a folder on its own disk. */
function OtherDeviceRow({ destination: d, onTakeOver }: { destination: ExportDestination; onTakeOver?: () => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Icon name="folder" size={13} color={colors.textTertiary} />
        <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
          {d.name}
        </Text>
        {!d.enabled ? <Badge tone="neutral" label="paused" /> : null}
        <Badge tone="info" label={`on ${exporterName(d)}`} />
      </View>
      <Text variant="mono" tone="tertiary" numberOfLines={1}>
        {pathOf(d)}
      </Text>
      <OtherDeviceStatus destination={d} scheduleWords={SCHEDULE_WORDS[d.schedule]} />
      <OtherDeviceActions destination={d} onTakeOver={onTakeOver} />
    </View>
  );
}

/** A folder on this computer: the chosen path, and the native chooser. */
function FolderField({ label, help, path, onChange, onError }: { label: string; help?: string; path: string; onChange: (path: string) => void; onError: (message: string) => void }) {
  const choose = async () => {
    try {
      const picked = await pickExportFolder("export");
      if (picked) onChange(picked);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <SettingsField label={label} help={help}>
      <View style={styles.pathRow}>
        <View style={styles.path}>
          <Text variant="mono" tone={path ? "default" : "quaternary"} numberOfLines={1}>
            {path || "No folder chosen"}
          </Text>
        </View>
        <Button label="Choose…" variant="secondary" disabled={!canPickExportFolder()} onPress={() => void choose()} />
      </View>
    </SettingsField>
  );
}

function DestinationDialog({
  destination,
  others,
  onTakeOverInstead,
  onClose,
}: {
  destination?: ExportDestination;
  /** The folder exports other devices run, to catch a second export into the same folder. */
  others: ExportDestination[];
  onTakeOverInstead: (d: ExportDestination, path: string) => void;
  onClose: () => void;
}) {
  const { exports } = useCore();
  const sync = useSync();
  const [name, setName] = useState(destination?.name ?? "");
  const [schedule, setSchedule] = useState<ExportSchedule>(destination?.schedule ?? "changes");
  const [enabled, setEnabled] = useState(destination?.enabled ?? true);
  const [path, setPath] = useState(destination ? pathOf(destination) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Another device already writing this very path: most likely one folder a cloud drive keeps on
  // both, and two exporters writing it would get in each other's way.
  const clash = !destination && path ? others.find((d) => pathOf(d) === path) : undefined;

  const save = async () => {
    if (busy) return;
    if (!path) return setError("Choose a folder to export to.");
    setBusy(true);
    setError(null);
    try {
      await exports.save({ id: destination?.id, kind: "folder", name: name.trim(), schedule, enabled, path });
      sync.trigger();
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
        message={`Companion forgets “${destination.name}” on all your devices and stops exporting to it. The files already in the folder stay where they are.`}
        confirmLabel="Stop exporting"
        onConfirm={async () => {
          await exports.remove(destination.id);
          sync.trigger();
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
      <FolderField
        label="Folder"
        help="An empty folder is best: Companion replaces files it finds with the same names, and only ever deletes files it wrote."
        path={path}
        onChange={setPath}
        onError={setError}
      />
      {clash ? (
        <View style={styles.clash}>
          <SettingsNote tone="secondary">{`${exporterName(clash)} already exports to this folder.`}</SettingsNote>
          <View style={styles.buttonRow}>
            <Button label="Take it over instead" variant="secondary" size="sm" onPress={() => onTakeOverInstead(clash, path)} />
          </View>
        </View>
      ) : null}
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

/** Take another device's folder export over: this computer exports it from now on, into a folder
 *  on its own disk, and the other device stops the next time it connects. */
function TakeOverDialog({ destination, initialPath, onClose }: { destination: ExportDestination; initialPath?: string; onClose: () => void }) {
  const { exports } = useCore();
  const sync = useSync();
  const [path, setPath] = useState(initialPath ?? pathOf(destination));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = exporterName(destination);

  const take = async () => {
    if (busy) return;
    if (!path) return setError("Choose a folder to export to.");
    setBusy(true);
    setError(null);
    try {
      await exports.takeOver(destination.id, path);
      sync.trigger();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const hints = useDialogKeys({ onEnter: () => void take(), onEscape: busy ? undefined : onClose });

  return (
    <Dialog
      title="Export from this computer"
      width={480}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <View style={{ flex: 1 }} />
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          <Button label={busy ? "Taking over…" : "Take over"} kbd={hints ? "⏎" : undefined} disabled={busy} onPress={() => void take()} />
        </>
      }
    >
      <SettingsNote tone="secondary">{`${who} stops exporting when it next connects.`}</SettingsNote>
      <FolderField label="Folder on this computer" path={path} onChange={setPath} onError={setError} />
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </Dialog>
  );
}

const styles = {
  page: { gap: space.xxl },
  section: { gap: space.md },
  head: { gap: space.xs },
  buttonRow: { flexDirection: "row" as const },
  clash: { gap: space.sm },
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
  rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, minHeight: 26 },
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
