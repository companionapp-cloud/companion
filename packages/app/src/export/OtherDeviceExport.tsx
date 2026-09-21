import { useState } from "react";
import { View } from "react-native";
import { Button, Text, space } from "@companion/design-system";
import type { ExportDestination, ScheduledExportKind } from "@companion/core-bridge";
import { useCore } from "../CoreContext";
import { useSync } from "../SyncProvider";
import { ConfirmDialog } from "../ConfirmDialog";
import { timeAgo } from "../NotificationRow";

// An export that another device runs, as this one shows it (Settings › Export for a folder,
// Settings › Sync for Git). Every export syncs, so every device lists every export; only its
// exporter runs it, and the rest can pause it, resume it, remove it or (on a computer that can
// run exports) take it over. The exporter picks a change up the next time it syncs, and the
// core says when it hasn't yet (`pending`).

const WORDS: Record<ScheduledExportKind, { runs: string; ran: string }> = {
  folder: { runs: "Exports", ran: "Exported" },
  git: { runs: "Syncs", ran: "Synced" },
};

/** The device that runs an export, as the others call it. */
export function exporterName(d: ExportDestination): string {
  return d.deviceName || "Another device";
}

/** Where the exporter is, as far as this device knows: online now, or when it last synced. */
function whereabouts(d: ExportDestination): string | null {
  const who = exporterName(d);
  if (d.ownerOnline) return `${who} online`;
  if (d.ownerLastSeenAt) return `${who} last seen ${timeAgo(d.ownerLastSeenAt)}`;
  return null;
}

/** The status lines of another device's export: how often it runs and how its last run went
 *  (the exporter's own report), whether the exporter is around, and whether a change made
 *  elsewhere has reached it yet. `scheduleWords` reads after the verb: "when things change". */
export function OtherDeviceStatus({ destination: d, scheduleWords }: { destination: ExportDestination; scheduleWords: string }) {
  const words = WORDS[d.kind];
  const who = exporterName(d);
  const summary = d.enabled
    ? [`${words.runs} ${scheduleWords}`, d.lastSuccessAt && !d.lastError ? `${words.ran} ${timeAgo(d.lastSuccessAt)}` : null, whereabouts(d)]
    : ["Paused", whereabouts(d)];
  return (
    <>
      <Text variant="caption" tone="tertiary" numberOfLines={2}>
        {summary.filter(Boolean).join(" · ")}
      </Text>
      {d.enabled && d.lastError ? (
        <Text variant="caption" tone="danger" numberOfLines={3}>
          {d.lastError}
        </Text>
      ) : null}
      {d.pending ? (
        <Text variant="caption" tone="secondary">
          {d.enabled ? `Takes effect when ${who} next connects.` : `Stops when ${who} next connects.`}
        </Text>
      ) : null}
    </>
  );
}

/** Pause or resume, take over, and remove, for an export another device runs. `onTakeOver` is
 *  left out where this device can't run exports. */
export function OtherDeviceActions({ destination: d, onTakeOver }: { destination: ExportDestination; onTakeOver?: () => void }) {
  const { exports } = useCore();
  const sync = useSync();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const who = exporterName(d);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await exports.setEnabled(d.id, !d.enabled);
      sync.trigger();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <>
      <View style={styles.actions}>
        <Button label={d.enabled ? "Pause" : "Resume"} variant="secondary" size="sm" disabled={busy} onPress={() => void toggle()} />
        {onTakeOver ? <Button label="Take over…" variant="secondary" size="sm" disabled={busy} onPress={onTakeOver} /> : null}
        <Button label="Remove…" variant="ghost" size="sm" disabled={busy} onPress={() => setConfirmRemove(true)} />
      </View>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
      {confirmRemove ? (
        <ConfirmDialog
          portal
          title={d.kind === "git" ? "Stop syncing with this repository?" : "Stop this export?"}
          message={
            d.kind === "git"
              ? `${who} stops syncing when it next connects. The repository stays as it is.`
              : `${who} stops exporting when it next connects. The files already in the folder stay.`
          }
          confirmLabel={d.kind === "git" ? "Stop syncing" : "Stop exporting"}
          onConfirm={async () => {
            await exports.remove(d.id);
            sync.trigger();
          }}
          onClose={() => setConfirmRemove(false)}
        />
      ) : null}
    </>
  );
}

const styles = {
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.sm, marginTop: space.xs },
};
