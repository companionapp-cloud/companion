import { useState } from "react";
import { Button, useDensity } from "@companion/design-system";
import { useNav } from "../nav-context";
import { detectIos, dismissInstallPrompt, shouldOfferInstall } from "./iosInstall";
import { PromptStrip } from "./PromptStrip";

/** The strip across the top of the app that offers installing Companion to the Home Screen: in
 *  Safari on an iPhone or iPad (iOS 16.4+), the only way to launch it full screen with its own
 *  icon, no address bar. Dismissing it snoozes it for a while. Nothing shows anywhere else, or
 *  on the install guide itself. */
export function IOSPWAInstallBanner({ leftInset = 0 }: { leftInset?: number }) {
  const nav = useNav();
  const touch = useDensity() === "touch";
  const [offerInstall, setOfferInstall] = useState(() => shouldOfferInstall());

  if (nav.activeView === "install" || !offerInstall) return null;

  const device = detectIos()?.device === "ipad" ? "iPad" : "iPhone";
  return (
    <PromptStrip
      icon="smartphone"
      text={touch ? "Add Companion to your Home Screen." : `Add Companion to your Home Screen on this ${device}.`}
      action={<Button label="Show me how" variant="secondary" size={touch ? undefined : "sm"} onPress={() => nav.goView("install")} />}
      onDismiss={() => {
        dismissInstallPrompt();
        setOfferInstall(false);
      }}
      touch={touch}
      leftInset={leftInset}
    />
  );
}
