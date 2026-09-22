import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Button, Text, colors, radius, space } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useSync } from "../SyncProvider";
import { SettingsField, SettingsNote } from "../settingsUi";
import { detectIos } from "./iosInstall";
import { useWebPush } from "./WebPushProvider";

/** Settings › Notifications (web): whether this device gets task reminders pushed by the sync
 *  server — the way to be reminded while Companion is closed, and on iPhone and iPad the only way
 *  once it lives on the Home Screen. */
export function NotificationSettings() {
  const push = useWebPush();
  const sync = useSync();
  const nav = useNav();
  const [testSent, setTestSent] = useState(false);
  const ios = detectIos();

  const errorLine = push.error ? <SettingsNote tone="danger">{push.error}</SettingsNote> : null;

  if (push.support === "install-first") {
    const device = ios?.device === "ipad" ? "iPad" : "iPhone";
    return (
      <Section strip={<StatusStrip tone="warning" text="not installed · add to Home Screen first" />}>
        <SettingsField label="Reminders on this device" help={`On ${device}, only apps on your Home Screen can show notifications.`}>
          <Row>
            <Button label="Show me how" onPress={() => nav.goView("install")} />
          </Row>
        </SettingsField>
      </Section>
    );
  }

  if (push.support === "ios-outdated") {
    return (
      <Section strip={<StatusStrip tone="warning" text="needs iOS 16.4 or later" />}>
        <SettingsNote tone="secondary">Update iOS, then add Companion to your Home Screen.</SettingsNote>
      </Section>
    );
  }

  if (push.support === "unsupported") {
    return (
      <Section strip={<StatusStrip tone="warning" text="not supported in this browser" />}>
        <SettingsNote tone="secondary">Reminders only appear while Companion is open.</SettingsNote>
      </Section>
    );
  }

  if (!sync.connected) {
    return (
      <Section strip={<StatusStrip tone="warning" text="off · needs sync" />}>
        <SettingsField label="Reminders on this device" help="Sign in to sync to get reminders while Companion is closed.">
          <Row>
            <Button label="Open Sync" variant="secondary" onPress={() => nav.openRef({ kind: "view", view: "settings", section: "sync" })} />
          </Row>
        </SettingsField>
      </Section>
    );
  }

  if (push.permission === "denied") {
    const where = ios ? "Allow them in Settings › Notifications › Companion." : "Allow them in your browser’s site settings.";
    return (
      <Section strip={<StatusStrip tone="danger" text="blocked" />}>
        <SettingsField label="Reminders on this device" help={where}>
          <Row>
            <Button label={push.busy ? "…" : "Try again"} variant="secondary" disabled={push.busy} onPress={push.enable} />
          </Row>
          {errorLine}
        </SettingsField>
      </Section>
    );
  }

  if (!push.enabled) {
    return (
      <Section strip={<StatusStrip tone="warning" text="off" />}>
        <SettingsField label="Reminders on this device" help="Get reminders even when Companion is closed.">
          <Row>
            <Button label={push.busy ? "Turning on…" : "Turn on notifications"} disabled={push.busy} onPress={push.enable} />
          </Row>
          {errorLine}
        </SettingsField>
      </Section>
    );
  }

  return (
    <Section strip={<StatusStrip tone="success" text="on · works while Companion is closed" />}>
      <SettingsField label="Reminders on this device">
        <Row>
          <Button
            label={push.busy ? "Sending…" : "Send a test"}
            variant="secondary"
            disabled={push.busy}
            onPress={() => {
              setTestSent(false);
              void push.sendTest().then(() => setTestSent(true));
            }}
          />
          <Button label="Turn off" variant="ghost" disabled={push.busy} onPress={() => void push.disable()} />
        </Row>
        {testSent && !push.error ? <SettingsNote tone="secondary">Sent. It should appear in a few seconds.</SettingsNote> : null}
        {errorLine}
      </SettingsField>
      {sync.encrypted ? <SettingsNote>Encrypted titles show only if this device opened Companion in the week before.</SettingsNote> : null}
    </Section>
  );
}

function Section({ strip, children }: { strip: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.section}>
      {strip}
      {children}
    </View>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

/** The sunken status strip SyncSettings opens with: a 5px state dot and the mono state. */
function StatusStrip({ tone, text }: { tone: "success" | "warning" | "danger"; text: string }) {
  return (
    <View style={styles.strip}>
      <View style={[styles.dot, { backgroundColor: colors[tone] }]} />
      <Text variant="mono" tone={tone === "danger" ? "danger" : "secondary"} numberOfLines={2} style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

const styles = {
  section: { gap: space.xl },
  row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md, alignItems: "center" as const },
  strip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    padding: space.md,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
  },
  dot: { width: 5, height: 5, borderRadius: radius.full, flexShrink: 0 },
};
