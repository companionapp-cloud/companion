import { useState } from "react";
import { Button, useDensity } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useSync } from "../SyncProvider";
import { isStandalone } from "./iosInstall";
import { PromptStrip } from "./PromptStrip";
import { useWebPush } from "./WebPushProvider";

const DISMISS_KEY = "companion.pushPrompt.dismissedAt";
/** How long a dismissed "turn on notifications" banner stays away. */
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/** The strip that offers turning reminder notifications on (PLAN §6.4, web push): once Companion
 *  runs as an installed web app (on iOS the only kind that can be notified), is signed in to sync,
 *  and hasn't asked this device yet. Dismissing it snoozes it; Settings › Notifications stays the
 *  way to turn them on. Not shown on the install guide, which offers the same button itself. */
export function NotificationsPromptBanner({ leftInset = 0 }: { leftInset?: number }) {
  const nav = useNav();
  const sync = useSync();
  const push = useWebPush();
  const touch = useDensity() === "touch";
  const [offer, setOffer] = useState(() => !dismissed());

  const show =
    offer &&
    nav.activeView !== "install" &&
    isStandalone() &&
    push.support === "supported" &&
    sync.connected &&
    !push.enabled &&
    push.permission === "default";
  if (!show) return null;

  return (
    <PromptStrip
      icon="bell"
      text="Turn on notifications to get reminders when Companion is closed."
      action={<Button label={push.busy ? "Turning on…" : "Turn on"} size={touch ? undefined : "sm"} disabled={push.busy} onPress={push.enable} />}
      onDismiss={() => {
        snooze();
        setOffer(false);
      }}
      touch={touch}
      leftInset={leftInset}
    />
  );
}

function dismissed(now = Date.now()): boolean {
  try {
    const at = Number(globalThis.localStorage?.getItem(DISMISS_KEY) ?? "");
    return Number.isFinite(at) && at > 0 && now - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze(now = Date.now()): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, String(now));
  } catch {
    /* storage unavailable: offered again next launch */
  }
}
