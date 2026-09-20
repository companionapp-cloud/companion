import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import type { ImportCounts, ImportProgress, ThingsAreaOutline, ThingsPreview, ThingsProjectOutline, ThingsSummary } from "@companion/core-bridge";
import { Button, Divider, Icon, Text, colors, radius, space, useDensity } from "@companion/design-system";
import { useCore } from "./CoreContext";
import { Dialog } from "./Dialog";
import { useDialogKeys } from "./ConfirmDialog";
import { CheckBox, CodeBlock, SettingsNote } from "./settingsUi";
import { pickThingsSource, thingsPickerKind, type PickedThingsSource } from "./thingsSource";

// Importing from Things 3 (PLAN §6.12). The dialog opens from Settings › Import and, on the
// desktop, from File › Import › Things 3… — which arrives as an `import.things` event on the
// core's stream. Core reads the database and does the import; the dialog picks the file, shows
// what's in it, and lets the user choose what to bring: the Inbox, each area, each project.

const listeners = new Set<() => void>();

/** Open the Things import dialog (needs a {@link ThingsImportHost} mounted). */
export function openThingsImport(): void {
  listeners.forEach((open) => open());
}

/** Mounted once per shell: shows the import dialog when asked, from the app or the desktop menu. */
export function ThingsImportHost() {
  const { core } = useCore();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    listeners.add(show);
    const off = core.on("import.things", show);
    return () => {
      listeners.delete(show);
      off();
    };
  }, [core]);
  return open ? <ThingsImportDialog onClose={() => setOpen(false)} /> : null;
}

type Step =
  | { kind: "choose"; error?: string }
  | { kind: "scanning" }
  | { kind: "select"; preview: ThingsPreview; error?: string }
  | { kind: "importing"; progress?: ImportProgress; stopping?: boolean }
  | { kind: "done"; summary: ThingsSummary };

/** What's ticked: the Inbox, and each area and project by its Things id. */
interface Ticks {
  inbox: boolean;
  areas: Record<string, boolean>;
  projects: Record<string, boolean>;
}

function ThingsImportDialog({ onClose }: { onClose: () => void }) {
  const { core, imports } = useCore();
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [picked, setPicked] = useState<PickedThingsSource | null>(null);
  const [ticks, setTicks] = useState<Ticks>({ inbox: true, areas: {}, projects: {} });
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const pickedRef = useRef<PickedThingsSource | null>(null);
  const busy = step.kind === "scanning" || step.kind === "importing";

  // Uploaded bytes are staged in the bridge until the dialog is done with them.
  useEffect(() => () => pickedRef.current?.release?.(), []);

  const choose = async () => {
    let next: PickedThingsSource | null;
    try {
      next = await pickThingsSource(core);
    } catch (e) {
      setStep({ kind: "choose", error: message(e) });
      return;
    }
    if (!next) return;
    pickedRef.current?.release?.();
    pickedRef.current = next;
    setPicked(next);
    setStep({ kind: "scanning" });
    try {
      const preview = await imports.thingsScan(next.source);
      setTicks(tickEverything(preview));
      setIncludeCompleted(false);
      setStep({ kind: "select", preview });
    } catch (e) {
      setStep({ kind: "choose", error: message(e) });
    }
  };

  const run = async () => {
    if (step.kind !== "select" || !picked) return;
    const { preview } = step;
    setStep({ kind: "importing" });
    const off = imports.onProgress((progress) =>
      setStep((s) => (s.kind === "importing" ? { ...s, progress } : s)),
    );
    try {
      const summary = await imports.thingsRun({
        source: picked.source,
        includeCompleted,
        selection: {
          inbox: ticks.inbox,
          areas: preview.areas.filter((a) => ticks.areas[a.id]).map((a) => a.id),
          projects: allProjects(preview)
            .filter((p) => ticks.projects[p.id] && (includeCompleted || !p.finished))
            .map((p) => p.id),
        },
      });
      setStep({ kind: "done", summary });
    } catch (e) {
      setStep({ kind: "select", preview, error: message(e) });
    } finally {
      off();
    }
  };

  const stop = () => {
    setStep((s) => (s.kind === "importing" ? { ...s, stopping: true } : s));
    void imports.cancel();
  };

  const chosen = step.kind === "select" ? chosenCount(step.preview, ticks, includeCompleted) : 0;
  useDialogKeys({
    onEnter: step.kind === "choose" ? () => void choose() : step.kind === "select" && chosen > 0 ? () => void run() : step.kind === "done" ? onClose : undefined,
    onEscape: busy ? undefined : onClose,
  });

  const footer = (() => {
    switch (step.kind) {
      case "choose":
        return (
          <>
            <Button label="Cancel" variant="ghost" onPress={onClose} />
            <Button label="Choose Things database…" onPress={() => void choose()} />
          </>
        );
      case "scanning":
        return <Button label="Reading…" disabled />;
      case "select":
        return (
          <>
            <Button label="Choose another…" variant="ghost" onPress={() => void choose()} />
            <Button label="Cancel" variant="secondary" onPress={onClose} />
            <Button label={chosen > 0 ? `Import ${chosen} ${chosen === 1 ? "to-do" : "to-dos"}` : "Import"} disabled={chosen === 0 && !anythingTicked(step.preview, ticks)} onPress={() => void run()} />
          </>
        );
      case "importing":
        return <Button label={step.stopping ? "Stopping…" : "Stop"} variant="secondary" disabled={step.stopping} onPress={stop} />;
      case "done":
        return <Button label="Done" onPress={onClose} />;
    }
  })();

  return (
    <Dialog title="Import from Things 3" width={540} onClose={busy ? undefined : onClose} footer={footer}>
      {step.kind === "choose" ? <ChooseStep error={step.error} /> : null}
      {step.kind === "scanning" ? <SettingsNote tone="secondary">Reading {picked?.label ?? "your Things library"}…</SettingsNote> : null}
      {step.kind === "select" ? (
        <SelectStep
          preview={step.preview}
          label={picked?.label ?? ""}
          ticks={ticks}
          onTicks={setTicks}
          includeCompleted={includeCompleted}
          onIncludeCompleted={setIncludeCompleted}
          error={step.error}
        />
      ) : null}
      {step.kind === "importing" ? <ProgressStep progress={step.progress} /> : null}
      {step.kind === "done" ? <DoneStep summary={step.summary} /> : null}
    </Dialog>
  );
}

// --- steps -------------------------------------------------------------------------------

function ChooseStep({ error }: { error?: string }) {
  const kind = thingsPickerKind();
  return (
    <View style={styles.stack}>
      <SettingsNote tone="secondary">
        Companion reads Things’ own database and brings over your Inbox, areas and projects — with their headings, notes,
        checklists, dates, reminders and repeats. You choose what to import next.
      </SettingsNote>
      {kind === "panel" ? (
        <SettingsNote>
          Quit Things first so its latest changes are included. The panel opens in Things’ folder: open ThingsData, then
          choose “Things Database.thingsdatabase” (or a .zip of it).
        </SettingsNote>
      ) : kind === "document" ? (
        <SettingsNote>
          Choose a .zip of “Things Database.thingsdatabase”, or the main.sqlite inside it — made on a Mac, or exported from
          Things on this device as below.
        </SettingsNote>
      ) : (
        <>
          <SettingsNote>
            Quit Things, then find its database in Finder: choose Go › Go to Folder…, paste the path below, and open the
            ThingsData folder inside.
          </SettingsNote>
          <CodeBlock>~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/</CodeBlock>
          <SettingsNote>
            Choose “Things Database.thingsdatabase” — Safari zips it for you — or a .zip of it (right-click › Compress), or the
            main.sqlite and main.sqlite-wal inside it.
          </SettingsNote>
        </>
      )}
      {kind !== "panel" ? (
        <SettingsNote>
          {kind === "document" ? "On iPhone or iPad" : "No Mac?"} Things exports its database from Settings › General ›
          Diagnostics (enter code 491348). Open the .aar it makes in the Files app, compress the folder that appears, and choose
          the .zip.
        </SettingsNote>
      ) : null}
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </View>
  );
}

function SelectStep({
  preview,
  label,
  ticks,
  onTicks,
  includeCompleted,
  onIncludeCompleted,
  error,
}: {
  preview: ThingsPreview;
  label: string;
  ticks: Ticks;
  onTicks: (t: Ticks) => void;
  includeCompleted: boolean;
  onIncludeCompleted: (v: boolean) => void;
  error?: string;
}) {
  const [showNotes, setShowNotes] = useState(false);
  const shown = (p: ThingsProjectOutline) => includeCompleted || !p.finished;
  const setArea = (a: ThingsAreaOutline, on: boolean) => {
    // An area's box carries its projects with it; each project can then be unticked alone.
    const projects = { ...ticks.projects };
    a.projects.forEach((p) => (projects[p.id] = on));
    onTicks({ ...ticks, areas: { ...ticks.areas, [a.id]: on }, projects });
  };
  const setProject = (p: ThingsProjectOutline, on: boolean) => onTicks({ ...ticks, projects: { ...ticks.projects, [p.id]: on } });
  const completed = totalCompleted(preview);
  const finished = allProjects(preview).filter((p) => p.finished).length;
  const inboxSize = preview.inbox.tasks + preview.inbox.repeating + (includeCompleted ? preview.inbox.completed : 0);

  return (
    <View style={styles.stack}>
      {label ? (
        <Text variant="mono" tone="quaternary" numberOfLines={1}>
          {label}
        </Text>
      ) : null}
      <SettingsNote>Choose what to bring over. Areas and projects come whole — with their headings as a list — and single to-dos can’t be picked.</SettingsNote>

      {/* First, since it decides what the list below holds: finished projects only appear with it. */}
      <View style={styles.group}>
        <CheckBox checked={includeCompleted} onPress={() => onIncludeCompleted(!includeCompleted)} label="Include completed to-dos" />
        <SettingsNote>
          {completed > 0 || finished > 0
            ? `Things’ Logbook: ${plural(completed, "completed or canceled to-do")}${finished > 0 ? ` and ${plural(finished, "finished project")}, which import archived` : ""}.`
            : "Things’ Logbook is empty, so there’s nothing completed to bring."}
        </SettingsNote>
      </View>
      <Divider />

      {inboxSize > 0 ? (
        <View style={styles.group}>
          <Row checked={ticks.inbox} onPress={() => onTicks({ ...ticks, inbox: !ticks.inbox })} name="Inbox" detail={countText(preview.inbox, includeCompleted)} />
          <SettingsNote>Along with to-dos in no area or project. They land in Unsorted tasks.</SettingsNote>
        </View>
      ) : null}

      {preview.areas.length > 0 ? (
        <View style={styles.group}>
          <Text variant="eyebrow" tone="quaternary">
            Areas · {preview.areas.length}
          </Text>
          {preview.areas.map((a) => (
            <View key={a.id} style={styles.area}>
              <Row checked={!!ticks.areas[a.id]} onPress={() => setArea(a, !ticks.areas[a.id])} name={a.name} detail={areaDetail(a, includeCompleted)} strong />
              {a.projects.filter(shown).map((p) => (
                <Row key={p.id} indent checked={!!ticks.projects[p.id]} onPress={() => setProject(p, !ticks.projects[p.id])} name={p.name} detail={projectDetail(p, includeCompleted)} />
              ))}
            </View>
          ))}
        </View>
      ) : null}

      {preview.noArea.filter(shown).length > 0 ? (
        <View style={styles.group}>
          <Text variant="eyebrow" tone="quaternary">
            Projects in no area
          </Text>
          <SettingsNote>Companion projects belong to an area, so these go in a new area called “Things”.</SettingsNote>
          {preview.noArea.filter(shown).map((p) => (
            <Row key={p.id} checked={!!ticks.projects[p.id]} onPress={() => setProject(p, !ticks.projects[p.id])} name={p.name} detail={projectDetail(p, includeCompleted)} />
          ))}
        </View>
      ) : null}

      {preview.warnings.length > 0 ? (
        <View style={styles.group}>
          <Pressable onPress={() => setShowNotes((v) => !v)} style={styles.disclosure} aria-expanded={showNotes}>
            <Icon name={showNotes ? "chevronDown" : "chevronRight"} size={12} color={colors.textTertiary} />
            <Text variant="caption" tone="tertiary">
              {plural(preview.warnings.length, "thing")} to know about this library
            </Text>
          </Pressable>
          {showNotes ? preview.warnings.map((w, i) => <SettingsNote key={i}>• {w}</SettingsNote>) : null}
        </View>
      ) : null}

      <SettingsNote>Importing is one-way, and importing the same things twice makes copies.</SettingsNote>
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </View>
  );
}

const STAGES: Record<string, string> = {
  areas: "Creating areas",
  projects: "Creating projects",
  tasks: "Importing to-dos",
  lists: "Building lists",
  links: "Linking to-dos",
};

function ProgressStep({ progress }: { progress?: ImportProgress }) {
  const fraction = progress && progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <View style={styles.stack}>
      <SettingsNote tone="secondary">{progress ? `${STAGES[progress.stage] ?? "Importing"}…` : "Starting…"}</SettingsNote>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%` }]} />
      </View>
      {progress ? (
        <Text variant="mono" tone="quaternary">
          {progress.done} of {progress.total} steps
        </Text>
      ) : null}
    </View>
  );
}

function DoneStep({ summary }: { summary: ThingsSummary }) {
  const lines = [
    summary.areas && plural(summary.areas, "area"),
    summary.projects &&
      plural(summary.projects, "project") + (summary.repeatingProjects ? ` (${summary.repeatingProjects} repeating)` : ""),
    summary.tasks && plural(summary.tasks, "to-do"),
    summary.repeating && plural(summary.repeating, "repeating to-do"),
    summary.headings && plural(summary.headings, "heading"),
    summary.notes && plural(summary.notes, "project note"),
  ].filter(Boolean) as string[];
  return (
    <View style={styles.stack}>
      <SettingsNote tone="secondary">
        {summary.cancelled ? "Stopped. What was imported before you stopped stays: " : "Imported "}
        {lines.length ? lines.join(", ") : "nothing"}.
      </SettingsNote>
      {summary.warnings.length > 0 ? (
        <View style={styles.group}>
          <Text variant="eyebrow" tone="quaternary">
            Notes · {summary.warnings.length}
          </Text>
          {summary.warnings.map((w, i) => (
            <SettingsNote key={i}>• {w}</SettingsNote>
          ))}
        </View>
      ) : null}
      <SettingsNote>Repeating to-dos and projects need a connected sync server to keep repeating (Settings › Sync).</SettingsNote>
    </View>
  );
}

/** One tickable line: a checkbox with the name, and a quiet detail (counts) after it. */
function Row({ checked, onPress, name, detail, indent, strong }: { checked: boolean; onPress: () => void; name: string; detail: string; indent?: boolean; strong?: boolean }) {
  const touch = useDensity() === "touch";
  return (
    <View style={[styles.row, indent ? styles.indent : null, touch ? styles.rowTouch : null]}>
      <CheckBox checked={checked} onPress={onPress} ariaLabel={`Import ${name}`} />
      <Pressable onPress={onPress} style={styles.rowText}>
        <Text variant={strong ? "label" : "caption"} tone={checked ? "default" : "tertiary"} numberOfLines={1} style={styles.rowName}>
          {name}
        </Text>
        <Text variant="mono" tone="quaternary" numberOfLines={1}>
          {detail}
        </Text>
      </Pressable>
    </View>
  );
}

// --- helpers -------------------------------------------------------------------------------

function tickEverything(preview: ThingsPreview): Ticks {
  const ticks: Ticks = { inbox: true, areas: {}, projects: {} };
  preview.areas.forEach((a) => (ticks.areas[a.id] = true));
  allProjects(preview).forEach((p) => (ticks.projects[p.id] = true));
  return ticks;
}

function allProjects(preview: ThingsPreview): ThingsProjectOutline[] {
  return [...preview.areas.flatMap((a) => a.projects), ...preview.noArea];
}

function size(c: ImportCounts, includeCompleted: boolean): number {
  return c.tasks + c.repeating + (includeCompleted ? c.completed : 0);
}

/** How many to-dos the ticked containers hold — the Import button's count. */
function chosenCount(preview: ThingsPreview, ticks: Ticks, includeCompleted: boolean): number {
  let n = ticks.inbox ? size(preview.inbox, includeCompleted) : 0;
  for (const a of preview.areas) {
    if (ticks.areas[a.id]) n += size(a, includeCompleted);
  }
  for (const p of allProjects(preview)) {
    if (ticks.projects[p.id] && (includeCompleted || !p.finished)) n += size(p, includeCompleted);
  }
  return n;
}

/** An empty area or project can still be imported (it's structure), so Import stays enabled
 *  while anything at all is ticked. */
function anythingTicked(preview: ThingsPreview, ticks: Ticks): boolean {
  return ticks.inbox || preview.areas.some((a) => ticks.areas[a.id]) || allProjects(preview).some((p) => ticks.projects[p.id]);
}

function totalCompleted(preview: ThingsPreview): number {
  return preview.inbox.completed + preview.areas.reduce((n, a) => n + a.completed, 0) + allProjects(preview).reduce((n, p) => n + p.completed, 0);
}

function countText(c: ImportCounts, includeCompleted: boolean): string {
  const parts: string[] = [];
  if (c.tasks) parts.push(plural(c.tasks, "to-do"));
  if (c.repeating) parts.push(`${c.repeating} repeating`);
  if (includeCompleted && c.completed) parts.push(`${c.completed} completed`);
  return parts.length ? parts.join(" · ") : "empty";
}

function areaDetail(a: ThingsAreaOutline, includeCompleted: boolean): string {
  const own = size(a, includeCompleted) > 0 ? `${countText(a, includeCompleted)} of its own` : "";
  const projects = a.projects.filter((p) => includeCompleted || !p.finished).length;
  return [projects ? plural(projects, "project") : "", own].filter(Boolean).join(" · ") || "empty";
}

function projectDetail(p: ThingsProjectOutline, includeCompleted: boolean): string {
  const parts = [countText(p, includeCompleted)];
  if (p.headings) parts.push(plural(p.headings, "heading"));
  if (p.repeats) parts.push("repeats");
  if (p.finished) parts.push("finished");
  return parts.join(" · ");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function message(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text || "Something went wrong reading that database.";
}

const styles = {
  stack: { gap: space.md },
  group: { gap: space.xs },
  area: { gap: space.xxs },
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, minHeight: 24 },
  rowTouch: { minHeight: 44 },
  indent: { marginLeft: space.xl },
  rowText: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "baseline" as const, gap: space.sm },
  rowName: { flexShrink: 1 },
  disclosure: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs },
  track: { height: 6, borderRadius: radius.sm, backgroundColor: colors.surfaceSunken, overflow: "hidden" as const },
  fill: { height: 6, backgroundColor: colors.accent },
};
