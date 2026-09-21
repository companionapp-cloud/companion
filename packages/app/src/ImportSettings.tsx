import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Text, colors, radius, space } from "@companion/design-system";
import type { FileImportReport } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";
import { useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { CheckBox, SettingsNote } from "./settingsUi";
import { canPickExportFolder, onScheduledExportRequest, pickExportFolder, takeScheduledExportRequest } from "./export/scheduling";
import { openThingsImport } from "./ThingsImport";
import { canPickThingsSource } from "./thingsSource";

/** Settings › Import (PLAN §6.12): bring work over from somewhere else — a folder of Markdown
 *  files, or Things 3. Each opens a dialog that shows what it found before anything is written. */
export function ImportSettings() {
  const { core } = useCore();
  const available = canPickThingsSource(core);
  const [importingFiles, setImportingFiles] = useState(false);
  // File › Import › Markdown Files… lands here.
  useEffect(() => {
    const take = () => {
      if (takeScheduledExportRequest("import")) setImportingFiles(true);
    };
    take();
    return onScheduledExportRequest(take);
  }, []);
  return (
    <View style={styles.page}>
      <View style={styles.section}>
        <Text variant="eyebrow" tone="quaternary">
          Markdown files
        </Text>
        <SettingsNote>
          Bring in a folder of Markdown files — a Companion export, an Obsidian vault, or any folder of notes. Each file becomes
          a note (or a task, if it says so), links between them are kept, the images and files they embed come along, and an
          Areas folder layout files them into areas and projects. It’s a one-time import: it only adds to your workspace, and never deletes anything.
        </SettingsNote>
        <View style={styles.actions}>
          <Button label="Import Markdown files…" variant="secondary" disabled={!canPickExportFolder()} onPress={() => setImportingFiles(true)} />
        </View>
        {!canPickExportFolder() ? <SettingsNote>Importing a folder is available in the Companion desktop app.</SettingsNote> : null}
      </View>
      {importingFiles ? <FileImportDialog onClose={() => setImportingFiles(false)} /> : null}
      <View style={styles.section}>
        <Text variant="eyebrow" tone="quaternary">
          Things 3
        </Text>
        <SettingsNote>
          Bring your Inbox, areas and projects over from Things 3 — with their headings, notes, checklists, dates, reminders and
          repeating to-dos. You choose which areas and projects to import, and whether to include completed to-dos.
        </SettingsNote>
        <View style={styles.actions}>
          <Button label="Import from Things 3…" variant="secondary" disabled={!available} onPress={openThingsImport} />
        </View>
        {!available ? <SettingsNote>Choosing a file isn’t available on this device.</SettingsNote> : null}
      </View>
    </View>
  );
}

/** Choose a folder, see what's in it, import it. */
function FileImportDialog({ onClose }: { onClose: () => void }) {
  const { importFiles } = useCore();
  const sync = useSync();
  const [path, setPath] = useState("");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [scan, setScan] = useState<FileImportReport | null>(null);
  const [done, setDone] = useState<FileImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const look = async (folder: string, update: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setScan(await importFiles.scan(folder, update));
    } catch (e) {
      setScan(null);
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const choose = async () => {
    try {
      const picked = await pickExportFolder("import");
      if (!picked) return;
      setPath(picked);
      await look(picked, updateExisting);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const run = async () => {
    if (busy || !scan) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await importFiles.run(path, updateExisting));
      sync.trigger();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const report = done ?? scan;
  const toWrite = scan ? scan.summary.created + scan.summary.updated : 0;
  const hints = useDialogKeys({ onEnter: done ? onClose : () => void run(), onEscape: busy ? undefined : onClose });
  const counts = (r: FileImportReport) =>
    [
      `${r.summary.notes} ${r.summary.notes === 1 ? "note" : "notes"}`,
      `${r.summary.tasks} ${r.summary.tasks === 1 ? "task" : "tasks"}`,
      `${r.summary.canvases} ${r.summary.canvases === 1 ? "canvas" : "canvases"}`,
      ...(r.summary.attachments ? [`${r.summary.attachments} ${r.summary.attachments === 1 ? "attachment" : "attachments"}`] : []),
    ].join(", ");

  return (
    <Dialog
      title="Import Markdown files"
      width={500}
      onClose={busy ? undefined : onClose}
      footer={
        done ? (
          <Button label="Done" kbd={hints ? "⏎" : undefined} onPress={onClose} />
        ) : (
          <>
            <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
            <Button label={busy ? "Working…" : toWrite ? `Import ${toWrite} ${toWrite === 1 ? "item" : "items"}` : "Import"} kbd={hints ? "⏎" : undefined} disabled={busy || !toWrite} onPress={() => void run()} />
          </>
        )
      }
    >
      {done ? (
        <SettingsNote tone="secondary">
          Imported {counts(done)}
          {done.summary.updated ? ` (${done.summary.updated} updated)` : ""}.{done.summary.failed ? ` ${done.summary.failed} couldn’t be read.` : ""}
        </SettingsNote>
      ) : (
        <>
          <View style={styles.pathRow}>
            <View style={styles.path}>
              <Text variant="mono" tone={path ? "default" : "quaternary"} numberOfLines={1}>
                {path || "No folder chosen"}
              </Text>
            </View>
            <Button label="Choose…" variant="secondary" disabled={busy} onPress={() => void choose()} />
          </View>
          {scan ? (
            <SettingsNote tone="secondary">
              {scan.files ? `Found ${scan.files} ${scan.files === 1 ? "file" : "files"}: ${counts(scan)} to import` : "No Markdown or canvas files in that folder"}
              {scan.summary.updated ? `, ${scan.summary.updated} of them updating what’s already here` : ""}
              {scan.summary.skipped ? `; ${scan.summary.skipped} skipped` : ""}.
            </SettingsNote>
          ) : null}
          <CheckBox
            checked={updateExisting}
            onPress={() => {
              const next = !updateExisting;
              setUpdateExisting(next);
              if (path) void look(path, next);
            }}
            label="Update notes and tasks that are already in Companion"
          />
          <SettingsNote>
            Files exported from this workspace name the item they came from. Left off, those are skipped, so importing an export
            never overwrites newer work; turned on, each one replaces its item’s title, text and details with the file’s.
          </SettingsNote>
        </>
      )}
      {report && report.problems.length ? (
        <View style={styles.problems}>
          {report.problems.slice(0, 8).map((p) => (
            <Text key={p.path} variant="caption" tone={p.action === "failed" ? "danger" : "tertiary"} numberOfLines={1}>
              {p.path} — {p.reason || p.action}
            </Text>
          ))}
          {report.problems.length > 8 ? (
            <Text variant="caption" tone="tertiary">
              …and {report.summary.skipped + report.summary.failed - 8} more
            </Text>
          ) : null}
        </View>
      ) : null}
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </Dialog>
  );
}

const styles = {
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
  problems: { gap: 2, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surfaceSunken },
  page: { gap: space.xl },
  section: { gap: space.sm },
  actions: { flexDirection: "row" as const, marginTop: space.xs },
};
