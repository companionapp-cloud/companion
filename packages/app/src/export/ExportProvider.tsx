import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { Icon, IconButton, Spinner, Text, colors, radius, shadow, space } from "@companion/design-system";
import { useCore } from "../CoreContext";
import { useDocumentSource } from "../DocumentSourceContext";
import { Overlay } from "../Overlay";
import { canExport, renderExport, type ExportDeps } from "./exporter";
import { exportMenuHost } from "./menuHost";
import { openExportSink, type ExportSink } from "./fileSink";
import { formatsFor, mimeOf, safeFilename, type ExportFile, type ExportFormat, type ExportTarget } from "./types";

export interface ExportStore {
  /** false where this platform can't export (native, for now): hide the controls. */
  available: boolean;
  busy: boolean;
  /** Export the targets — one file each — in a format. One target asks for a filename; several
   *  ask for a folder (a .zip in the browser). */
  run: (targets: ExportTarget[], format: ExportFormat) => Promise<void>;
  /** What this window would export right now — the open document, or the multiselection — so
   *  the desktop's File › Export menu can offer it. null when nothing exportable is showing. */
  setScope: (targets: ExportTarget[] | null) => void;
}

type Status =
  | { phase: "working"; done: number; total: number }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

const ExportCtx = createContext<ExportStore | null>(null);

const FALLBACK_TITLE: Record<ExportTarget["kind"], string> = { note: "Untitled", task: "Untitled task", canvas: "Untitled canvas" };

/** Note and task edits are saved on a short debounce (NotesProvider, TaskEditor); an export
 *  reads from the core, so it waits that out to include what was just typed. */
const SAVE_SETTLE_MS = 450;

export function ExportProvider({ children }: { children: ReactNode }) {
  const core = useCore();
  const documentSource = useDocumentSource();
  const [status, setStatus] = useState<Status | null>(null);
  const busyRef = useRef(false);
  const scopeRef = useRef<ExportTarget[] | null>(null);
  const available = canExport();

  const deps = useMemo<ExportDeps>(
    () => ({ notes: core.notes, tasks: core.tasks, canvases: core.canvases, graph: core.graph, projects: core.projects, objectTypes: core.objectTypes, documentSource }),
    [core, documentSource],
  );

  const run = useCallback(
    async (targets: ExportTarget[], format: ExportFormat) => {
      if (!available || busyRef.current || !targets.length) return;
      busyRef.current = true;
      const ext = `.${format}`;
      const total = targets.length;
      let sink: ExportSink | null = null;
      try {
        setStatus({ phase: "working", done: 0, total });
        await new Promise((resolve) => setTimeout(resolve, SAVE_SETTLE_MS));

        if (total === 1) {
          // One file: draw it first, so the save panel can open on its real name.
          const out = await renderExport(deps, targets[0], format);
          const name = safeFilename(out.title, FALLBACK_TITLE[targets[0].kind]) + ext;
          sink = await openExportSink({ count: 1, suggestedName: name });
          if (!sink) return setStatus(null);
          await sink.write({ name, mime: mimeOf(format), data: out.data });
          const saved = await sink.close();
          return setStatus({ phase: "done", message: `Exported “${saved ?? name}”` });
        }

        // Several: ask where they go before the long part, then draw them one at a time.
        sink = await openExportSink({ count: total, suggestedName: "Companion Export" });
        if (!sink) return setStatus(null);
        const taken = new Set<string>();
        let failed = 0;
        for (let i = 0; i < total; i++) {
          setStatus({ phase: "working", done: i, total });
          try {
            const out = await renderExport(deps, targets[i], format);
            const stem = safeFilename(out.title, FALLBACK_TITLE[targets[i].kind]);
            let name = stem + ext;
            for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} ${n}${ext}`;
            taken.add(name.toLowerCase());
            const file: ExportFile = { name, mime: mimeOf(format), data: out.data };
            await sink.write(file);
          } catch (err) {
            console.warn("export: item failed", targets[i], err);
            failed++;
          }
        }
        if (failed === total) throw new Error("None of the items could be exported.");
        const saved = await sink.close();
        const count = total - failed;
        const message = `Exported ${count} file${count === 1 ? "" : "s"}${saved ? ` to “${saved}”` : ""}`;
        setStatus(failed ? { phase: "error", message: `${message}. ${failed} couldn’t be exported.` } : { phase: "done", message });
      } catch (err) {
        sink?.abort();
        setStatus({ phase: "error", message: err instanceof Error && err.message ? err.message : "The export failed." });
      } finally {
        busyRef.current = false;
      }
    },
    [available, deps],
  );

  // A finished export's note clears itself; an error stays until dismissed.
  useEffect(() => {
    if (status?.phase !== "done") return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  // The desktop's File › Export menu: keep it offering what this window shows — re-announced on
  // focus, since every window shares the one menu — and run what it picks.
  const announce = useCallback(() => {
    const kind = scopeRef.current?.[0]?.kind;
    exportMenuHost()?.setFormats(available && kind ? formatsFor(kind) : []);
  }, [available]);
  const setScope = useCallback(
    (targets: ExportTarget[] | null) => {
      scopeRef.current = targets && targets.length ? targets : null;
      if (typeof document === "undefined" || document.hasFocus()) announce();
    },
    [announce],
  );
  useEffect(() => {
    const host = exportMenuHost();
    if (!host || typeof window === "undefined") return;
    const off = host.onRequest((format) => {
      const targets = scopeRef.current;
      if (targets && formatsFor(targets[0].kind).includes(format)) void run(targets, format);
    });
    window.addEventListener("focus", announce);
    announce();
    return () => {
      off();
      window.removeEventListener("focus", announce);
    };
  }, [announce, run]);

  const value = useMemo<ExportStore>(() => ({ available, busy: status?.phase === "working", run, setScope }), [available, status, run, setScope]);

  return (
    <ExportCtx.Provider value={value}>
      {children}
      {status ? <ExportStatus status={status} onDismiss={() => setStatus(null)} /> : null}
    </ExportCtx.Provider>
  );
}

const UNAVAILABLE: ExportStore = { available: false, busy: false, run: async () => undefined, setScope: () => undefined };

/** The export store — or, where no provider is mounted (shells that host the shared editors on
 *  their own), one that offers nothing. */
export function useExport(): ExportStore {
  return useContext(ExportCtx) ?? UNAVAILABLE;
}

/** Declares what this window would export right now (see {@link ExportStore.setScope}). Pass a
 *  stable value — it's compared by its kinds and ids. */
export function useExportScope(targets: ExportTarget[] | null): void {
  const { setScope } = useExport();
  const key = targets ? targets.map((t) => `${t.kind}:${t.id}`).join(",") : "";
  const latest = useRef(targets);
  latest.current = targets;
  useEffect(() => {
    setScope(latest.current);
    return () => setScope(null);
  }, [key, setScope]);
}

/** A quiet pill at the foot of the window: progress while exporting, then where the files went. */
function ExportStatus({ status, onDismiss }: { status: Status; onDismiss: () => void }) {
  const label =
    status.phase === "working" ? (status.total > 1 ? `Exporting ${Math.min(status.done + 1, status.total)} of ${status.total}…` : "Exporting…") : status.message;
  return (
    <Overlay>
      <View style={styles.anchor} pointerEvents="box-none">
        <View style={styles.pill} aria-live="polite">
          {status.phase === "working" ? (
            <Spinner inline />
          ) : (
            <Icon name={status.phase === "done" ? "check" : "close"} size={13} color={status.phase === "done" ? colors.success : colors.danger} />
          )}
          <Text variant="label" numberOfLines={2} style={{ flexShrink: 1 }}>
            {label}
          </Text>
          {status.phase === "error" ? (
            <IconButton label="Dismiss" size="sm" onPress={onDismiss}>
              <Icon name="close" size={11} color={colors.textTertiary} />
            </IconButton>
          ) : null}
        </View>
      </View>
    </Overlay>
  );
}

const styles = {
  anchor: {
    position: (Platform.OS === "web" ? "fixed" : "absolute") as "absolute",
    left: 0,
    right: 0,
    // Clear of the status bar and an editor's formatting bar.
    bottom: 72,
    alignItems: "center" as const,
    zIndex: 1000,
  },
  pill: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    maxWidth: 420,
    minHeight: 32,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    ...shadow.md,
  },
};
