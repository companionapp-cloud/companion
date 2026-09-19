// The updater window (apps/desktop/update_window.go). Updates are mandatory, and one installs in
// this window: at launch it opens instead of the main window, and mid-session it takes the place
// of the app's windows. It shows the download, the install and the restart. If the update
// fails, it says why and lets you continue into Companion; the next check tries again.
//
// A page of its own (updater.html), apart from the app: it only needs the design system and the
// Wails runtime, which also initializes the window drag handling.
import "@wailsio/runtime";
import { Browser, Clipboard, Events, Window } from "@wailsio/runtime";
import { useEffect, useState } from "react";
import { AppRegistry, View, type LayoutChangeEvent } from "react-native";
import { BrandMark, Button, Text, colors, dragRegion, radius, space } from "@companion/design-system";

type UpdatePhase = "idle" | "downloading" | "installing" | "restarting" | "failed";

/** Mirrors updateState in apps/desktop/updates.go. */
interface UpdateState {
  phase: UpdatePhase;
  current?: string;
  version?: string;
  written?: number;
  total?: number;
  error?: string;
  /** This copy can't be replaced in place; the failure explains how to update by hand. */
  manual?: boolean;
  releaseUrl?: string;
}

const BREW_UPGRADE = "brew upgrade --cask companionapp-cloud/tap/companion";

/** The live update state: GET /update as the window opens, then the "update:state" events. */
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

// The window opens at the progress view's size (update_window.go). Fit its height to what's
// shown: a failure needs more room. onLayout works on react-native-web but isn't in the shared
// RN typings, hence the cast (as with CanvasThumbnail's).
let fittedHeight = 0;
const fitToContent = {
  onLayout(e: LayoutChangeEvent) {
    const height = Math.ceil(e.nativeEvent.layout.height);
    if (height <= 0 || height === fittedHeight) return;
    fittedHeight = height;
    // The width is the one update_window.go gave the window; only the height follows the page.
    Window.Size()
      .then(({ width }) => Window.SetSize(width, height))
      .catch(() => {});
  },
} as Record<string, unknown>;

function UpdaterWindow() {
  const state = useUpdateState();
  if (!state || state.phase === "idle") return null;
  // The whole window is a drag region; the buttons opt back out.
  return (
    <View {...fitToContent} style={[styles.window, dragRegion]}>
      <BrandMark size={40} />
      <View style={styles.body}>
        {state.phase === "failed" ? <UpdateFailed state={state} /> : <UpdateProgress state={state} />}
      </View>
    </View>
  );
}

function UpdateProgress({ state }: { state: UpdateState }) {
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
    <>
      <Text variant="title">Updating Companion</Text>
      <Text tone="secondary" style={styles.message}>
        {`Companion ${state.version ?? ""} is required. It opens by itself once the update is installed.`}
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
    </>
  );
}

function UpdateFailed({ state }: { state: UpdateState }) {
  const [copied, setCopied] = useState(false);
  // Closing the window is what continues: it dismisses the failure and gives the app back.
  const proceed = () => void Window.Close();
  return (
    <>
      <Text variant="title">{`Couldn’t install Companion ${state.version ?? ""}`}</Text>
      <Text tone="secondary" style={styles.message}>
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
        {state.manual ? (
          <>
            <Button label="Continue" variant="ghost" size="sm" onPress={proceed} />
            <Button
              label={copied ? "Copied" : "Copy command"}
              variant="secondary"
              size="sm"
              onPress={() => void Clipboard.SetText(BREW_UPGRADE).then(() => setCopied(true))}
            />
            {state.releaseUrl ? (
              <Button label="Download" variant="primary" size="sm" onPress={() => void Browser.OpenURL(state.releaseUrl!)} />
            ) : null}
          </>
        ) : (
          <Button label="Continue" variant="primary" size="sm" onPress={proceed} />
        )}
      </View>
    </>
  );
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

const styles = {
  window: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: space.xl,
    // The titlebar is transparent (update_window.go): start below the traffic lights.
    paddingTop: 36,
    paddingHorizontal: space.xl2,
    paddingBottom: space.xl2,
  },
  body: { flex: 1, minWidth: 0, gap: space.md },
  message: { lineHeight: 19 },
  // DOM styles (the progress bar is plain divs).
  track: {
    height: 4,
    marginTop: space.sm,
    borderRadius: radius.xs,
    background: colors.surfaceSunken,
    overflow: "hidden",
  },
  fill: { height: "100%", background: colors.accent, transition: "width 120ms linear" },
  statusRow: {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    alignItems: "baseline" as const,
    gap: space.md,
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

AppRegistry.registerComponent("CompanionUpdater", () => UpdaterWindow);
AppRegistry.runApplication("CompanionUpdater", { rootTag: document.getElementById("root")! });
