import { Browser, Clipboard, Events } from "@wailsio/runtime";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";
import { Button, Text, colors, dragRegion, radius, shadow, space } from "@companion/design-system";

// Forced updates (apps/desktop/updates.go). The Go side checks GitHub on launch, hourly and on
// wake, and a newer release is mandatory: while it downloads, installs and restarts, this covers
// every window. If an attempt fails, Companion keeps working and shows a dismissible notice;
// the next check retries.

export type UpdatePhase = "idle" | "downloading" | "installing" | "restarting" | "failed";

/** Mirrors updateState in apps/desktop/updates.go. */
export interface UpdateState {
  phase: UpdatePhase;
  current?: string;
  version?: string;
  written?: number;
  total?: number;
  error?: string;
  /** This copy can't be replaced in place; the notice explains how to update by hand. */
  manual?: boolean;
  releaseUrl?: string;
}

const BLOCKING: ReadonlySet<UpdatePhase> = new Set(["downloading", "installing", "restarting"]);
const BREW_UPGRADE = "brew upgrade --cask companionapp-cloud/tap/companion";

/** The live update state: GET /update for a window that opens mid-update, then the
 *  "update:state" events. */
function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    const off = Events.On("update:state", (event: { data?: unknown }) => {
      const data = Array.isArray(event?.data) ? event.data[0] : event?.data;
      if (data && typeof data === "object") setState(data as UpdateState);
    });
    fetch("/update")
      .then((res) => (res.ok ? (res.json() as Promise<UpdateState>) : null))
      // An event that arrived while this was in flight is newer; keep it.
      .then((initial) => live && initial && setState((prev) => prev ?? initial))
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** Mounted beside the app in every window except the quick-capture panel. */
export function UpdateGate() {
  const state = useUpdateState();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const blocking = !!state && BLOCKING.has(state.phase);

  // Nothing under the update screen may act: drop focus (an open editor commits its pending
  // save on the way out) and swallow keystrokes, app shortcuts included.
  useEffect(() => {
    if (!blocking) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [blocking]);

  if (!state) return null;
  if (blocking) return createPortal(<UpdateScreen state={state} />, document.body);
  if (state.phase === "failed") {
    // Dismissing hides this failure only; a different one (or the next version) shows again.
    const key = `${state.version}\n${state.error}`;
    if (key !== dismissed) {
      return createPortal(<UpdateFailedNotice state={state} onDismiss={() => setDismissed(key)} />, document.body);
    }
  }
  return null;
}

/** The blocking screen: a card over the scrim with the download's progress. The scrim stays a
 *  window drag region so the window can still be moved while it's up. */
export function UpdateScreen({ state }: { state: UpdateState }) {
  const downloading = state.phase === "downloading";
  const fraction = downloading ? (state.total ? Math.min(1, (state.written ?? 0) / state.total) : 0) : 1;
  const status = downloading
    ? `Downloading… ${Math.round(fraction * 100)}%`
    : state.phase === "installing"
      ? "Installing…"
      : "Restarting…";
  const detail =
    downloading && state.total
      ? `${megabytes(state.written ?? 0)} / ${megabytes(state.total)} MB`
      : state.current && state.version
        ? `${state.current} → ${state.version}`
        : "";

  return (
    <View style={[styles.scrim, dragRegion]}>
      <View style={styles.card} aria-label="Updating Companion">
        <Text variant="title">Updating Companion</Text>
        <Text tone="secondary" style={styles.message}>
          {`Companion ${state.version ?? ""} is required. It restarts by itself once the update is installed.`}
        </Text>
        {/* DOM, like Spinner.web.tsx: the RN View shim has no progressbar role. */}
        <div
          role="progressbar"
          aria-label="Update progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          style={styles.track}
        >
          <div style={{ ...styles.fill, width: `${fraction * 100}%` }} />
        </div>
        <View style={styles.statusRow}>
          <Text variant="caption" tone="secondary">
            {status}
          </Text>
          <Text variant="mono" tone="tertiary">
            {detail}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Bottom-right notice for an update that couldn't be installed. Non-blocking. */
export function UpdateFailedNotice({ state, onDismiss }: { state: UpdateState; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <View style={styles.notice} aria-label="Update failed">
      <Text variant="label">{`Couldn’t install Companion ${state.version ?? ""}`}</Text>
      <Text variant="caption" tone="secondary" style={styles.message}>
        {state.manual
          ? "Companion can’t replace itself where it’s installed. Update it with Homebrew, or download the new version."
          : "Companion will try again later."}
      </Text>
      {state.error ? (
        <Text variant="mono" tone="tertiary" numberOfLines={3}>
          {state.error}
        </Text>
      ) : null}
      {state.manual ? (
        <View style={styles.command}>
          <Text variant="mono">{BREW_UPGRADE}</Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <Button label="Dismiss" variant="ghost" size="sm" onPress={onDismiss} />
        {state.manual ? (
          <Button
            label={copied ? "Copied" : "Copy command"}
            variant="secondary"
            size="sm"
            onPress={() => void Clipboard.SetText(BREW_UPGRADE).then(() => setCopied(true))}
          />
        ) : null}
        {state.manual && state.releaseUrl ? (
          <Button label="Download" variant="primary" size="sm" onPress={() => void Browser.OpenURL(state.releaseUrl!)} />
        ) : null}
      </View>
    </View>
  );
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

const styles = {
  scrim: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: colors.scrim,
    padding: space.xl,
    zIndex: 1000,
  },
  card: {
    width: 400,
    maxWidth: "100%" as const,
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    padding: space.xl,
    gap: space.md,
  },
  message: { lineHeight: 19 },
  // DOM styles (the progress bar is plain divs).
  track: {
    height: 4,
    marginTop: space.sm,
    borderRadius: radius.xs,
    background: colors.surfaceSunken,
    overflow: "hidden",
  },
  fill: { height: "100%", background: colors.accent },
  statusRow: {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    alignItems: "baseline" as const,
    gap: space.md,
  },
  notice: {
    position: "absolute" as const,
    right: space.xl,
    bottom: space.xl,
    // Wide enough to keep BREW_UPGRADE on one line.
    width: 400,
    maxWidth: "90%" as const,
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    padding: space.lg,
    gap: space.sm,
    zIndex: 1000,
  },
  command: {
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
  },
  actions: {
    flexDirection: "row" as const,
    justifyContent: "flex-end" as const,
    gap: space.sm,
    marginTop: space.xs,
  },
};
