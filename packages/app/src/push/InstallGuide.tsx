import { useMemo, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { BrandMark, Button, Icon, Text, colors, font, radius, space, type IconName } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useSync } from "../SyncProvider";
import { Segmented } from "../settingsUi";
import { NavBar } from "../mobile/ui";
import { detectIos, iosSupportsWebPush, safariEra, type IosDevice, type SafariEra } from "./iosInstall";
import { useWebPush } from "./WebPushProvider";

// The install guide: how to put Companion on the Home Screen of an iPhone or iPad, so it launches
// full screen like any other app instead of a Safari tab. The steps follow what the reader is
// holding, because Apple keeps moving the button: Safari's Share sits in the toolbar through iOS 18,
// behind "···" in iOS 26's default Compact layout, and in the Page menu in iOS 27's; on an iPad it
// stays at the top right. Chrome shares from its address bar, and an app's built-in browser can't
// install at all. Safari readers can switch versions in case the one we read is wrong.

/** A step's illustration: the control it asks for. */
type Glyph = "share" | "more" | "pageMenu" | "squarePlus" | "add" | "app";

interface Step {
  glyph: Glyph;
  /** The instruction; **text** in double asterisks is a label on the reader's screen. */
  text: string;
}

function safariSteps(era: SafariEra, device: IosDevice): Step[] {
  if (device === "ipad") {
    const share: Step = { glyph: "share", text: "Tap the **Share** button at the top right of the screen, next to the address bar." };
    if (era === "legacy") {
      return [share, { glyph: "squarePlus", text: "Tap **Add to Home Screen**." }, { glyph: "add", text: "Tap **Add**." }];
    }
    return [
      share,
      { glyph: "squarePlus", text: `Tap **${era === "26" ? "More" : "View More"}**, then **Add to Home Screen**.` },
      { glyph: "add", text: "Leave **Open as Web App** on, then tap **Add**." },
    ];
  }
  if (era === "legacy") {
    return [
      { glyph: "share", text: "Tap the **Share** button in the toolbar at the bottom of the screen." },
      {
        glyph: "squarePlus",
        text: "Scroll down and tap **Add to Home Screen**. Not listed? Tap **Edit Actions** at the bottom of the list to add it.",
      },
      { glyph: "add", text: "Tap **Add** in the top-right corner." },
    ];
  }
  const open: Step =
    era === "26"
      ? { glyph: "more", text: "Tap **···** at the bottom right of the screen." }
      : { glyph: "pageMenu", text: "Tap the **Page Menu** button, just left of the address bar." };
  return [
    open,
    { glyph: "share", text: "Tap **Share**." },
    { glyph: "squarePlus", text: "Scroll down (or tap **View More**) and tap **Add to Home Screen**." },
    { glyph: "add", text: "Leave **Open as Web App** on, then tap **Add**." },
  ];
}

/** Chrome on iOS 16.4+ adds web apps from the Share button in its address bar (Google's own steps). */
const CHROME_STEPS: Step[] = [
  { glyph: "share", text: "Tap **Share** on the right of the address bar." },
  { glyph: "squarePlus", text: "Tap **Add to Home Screen**." },
  { glyph: "add", text: "Tap **Add**." },
];

const OPEN_STEP: Step = { glyph: "app", text: "Open **Companion** from your Home Screen." };

const ERA_OPTIONS = [
  { value: "27", label: "iOS 27" },
  { value: "26", label: "iOS 26" },
  { value: "legacy", label: "iOS 16.4–18" },
] as const;

/** The guide itself, for either shell. `onDone` leaves it (the installed app landing here). */
export function InstallGuide({ onDone }: { onDone: () => void }) {
  const env = useMemo(() => detectIos(), []);
  const device: IosDevice = env?.device ?? "iphone";
  const deviceName = device === "ipad" ? "iPad" : "iPhone";
  const [era, setEra] = useState<SafariEra>(() => safariEra(env?.version ?? null));

  if (env?.standalone) return <Installed onDone={onDone} deviceName={deviceName} />;

  let intro: ReactNode;
  let steps: Step[] | null = null;
  let eraPicker = false;
  let footer: ReactNode = null;

  if (env && !iosSupportsWebPush(env)) {
    intro = (
      <Para>
        Installing works best on iOS 16.4 or later, and this {deviceName} reports iOS {env.version?.major}.
        {env.version?.minor}. Update in <B>Settings › General › Software Update</B>, then come back to this page.
      </Para>
    );
  } else if (env?.browser === "in-app") {
    intro = (
      <Para>
        You’re in another app’s built-in browser, which can’t add anything to your Home Screen. Open this page in <B>Safari</B> first:
        most apps have an <B>Open in Safari</B> (or <B>Open in browser</B>) option in their <B>···</B> menu. Or copy the link and paste
        it into Safari.
      </Para>
    );
    footer = <CopyLink />;
  } else if (env?.browser === "chrome") {
    intro = <Para>You can add Companion from Chrome. In Chrome:</Para>;
    steps = [...CHROME_STEPS, OPEN_STEP];
  } else if (env && env.browser !== "safari") {
    const name = env.browser === "edge" ? "Edge" : env.browser === "firefox" ? "Firefox" : "this browser";
    intro = (
      <Para>
        Safari is the surest way to install: copy the link below and open it in <B>Safari</B>, then follow the steps it shows. Or, in {name},
        look for <B>Share</B> (in the address bar or the menu), then tap <B>Add to Home Screen</B> and <B>Add</B>.
      </Para>
    );
    footer = <CopyLink label="Copy link for Safari" />;
  } else {
    intro = env ? (
      <Para>On your Home Screen, Companion opens like any other app. To add it, in Safari:</Para>
    ) : (
      <Para>
        On your iPhone or iPad, open this page in <B>Safari</B>, then:
      </Para>
    );
    steps = [...safariSteps(era, device), OPEN_STEP];
    eraPicker = true;
    // Apple's own caveat: in the Bottom and Top tab layouts, Share sits in the toolbar.
    if (device === "iphone" && era !== "legacy") {
      footer = (
        <Para>
          Using the <B>Bottom</B> or <B>Top</B> tab layout? Tap <B>Share</B> in the toolbar instead, then carry on from step 3.
        </Para>
      );
    }
  }

  return (
    <View style={styles.body}>
      <View style={styles.hero}>
        <BrandMark size={56} />
        <Text variant="heading" style={styles.center}>
          Install Companion on your {env ? deviceName : "iPhone or iPad"}
        </Text>
        <Text variant="body" tone="secondary" style={styles.center}>
          Launch it full screen from your Home Screen, no address bar or browser chrome.
        </Text>
      </View>
      {intro}
      {eraPicker ? (
        <View style={styles.eraRow}>
          <Text variant="caption" tone="tertiary">
            Steps for
          </Text>
          <Segmented<SafariEra> options={ERA_OPTIONS} value={era} onChange={setEra} />
        </View>
      ) : null}
      {steps ? (
        <View style={styles.steps}>
          {steps.map((step, i) => (
            <StepRow key={`${era}-${i}`} n={i + 1} step={step} />
          ))}
        </View>
      ) : null}
      {footer}
    </View>
  );
}

/** Reached from the Home Screen app itself (or opened there): installing is done, and what's left
 *  is turning reminder notifications on (web push), when this device can and hasn't yet. */
function Installed({ onDone, deviceName }: { onDone: () => void; deviceName: string }) {
  const push = useWebPush();
  const sync = useSync();
  const nav = useNav();
  const canEnable = push.support === "supported" && !push.enabled && push.permission !== "denied";
  return (
    <View style={styles.body}>
      <View style={styles.hero}>
        <BrandMark size={56} />
        <Text variant="heading" style={styles.center}>
          Companion is on your Home Screen
        </Text>
        <Text variant="body" tone="secondary" style={styles.center}>
          {push.enabled
            ? `Notifications are on. Reminders reach this ${deviceName} even when Companion is closed.`
            : canEnable
              ? "One last step: allow notifications so reminders reach you when Companion is closed."
              : `Launch it from there like any other app on your ${deviceName}: full screen, no browser bar.`}
        </Text>
      </View>
      <View style={styles.actions}>
        {canEnable && sync.connected ? (
          <Button label={push.busy ? "Turning on…" : "Turn on notifications"} disabled={push.busy} onPress={push.enable} />
        ) : null}
        {canEnable && !sync.connected ? (
          <Button label="Sign in to sync" onPress={() => nav.openRef({ kind: "view", view: "settings", section: "sync" })} />
        ) : null}
        <Button label={canEnable ? "Not now" : "Done"} variant={canEnable ? "ghost" : "primary"} onPress={onDone} />
      </View>
      {canEnable && !sync.connected ? <Para center>Reminders are sent by your sync server, so sign in to sync first.</Para> : null}
      {push.permission === "denied" ? (
        <Para center>
          Notifications are blocked. Open the Settings app › <B>Notifications</B> › <B>Companion</B> to allow them.
        </Para>
      ) : null}
      {push.error ? (
        <Text variant="caption" tone="danger" style={styles.center}>
          {push.error}
        </Text>
      ) : null}
    </View>
  );
}

function StepRow({ n, step }: { n: number; step: Step }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNumber}>
        <Text variant="mono" tone="secondary" style={styles.stepNumberText}>
          {n}
        </Text>
      </View>
      <StepGlyph glyph={step.glyph} />
      <Text variant="body" style={styles.stepText}>
        {rich(step.text)}
      </Text>
    </View>
  );
}

const GLYPH_ICONS: Partial<Record<Glyph, IconName>> = { share: "share", squarePlus: "squarePlus", add: "check" };

/** A tile drawing the control a step asks for, the way iOS draws it: Share's square-and-arrow,
 *  the "···" circle, Add to Home Screen's plus-in-a-square, or the app's own icon. The Page menu
 *  button is drawn by where it is — the left end of the address bar — rather than by an icon
 *  Apple may yet redraw. */
function StepGlyph({ glyph }: { glyph: Glyph }) {
  if (glyph === "app") return <BrandMark size={36} />;
  if (glyph === "pageMenu") {
    return (
      <View style={styles.glyph}>
        <View style={styles.addressBar}>
          <View style={styles.addressBarButton} />
        </View>
      </View>
    );
  }
  if (glyph === "more") {
    return (
      <View style={styles.glyph}>
        <View style={styles.moreCircle}>
          <Icon name="moreH" size={16} color={colors.textPrimary} strokeWidth={3} />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.glyph}>
      <Icon name={GLYPH_ICONS[glyph] ?? "dot"} size={20} color={glyph === "share" ? colors.info : colors.textPrimary} />
    </View>
  );
}

/** Copies the app's address, for pasting into Safari. */
function CopyLink({ label = "Copy link" }: { label?: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? "" : window.location.origin;
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!url || !clipboard) return null;
  return (
    <View style={styles.actions}>
      <Button
        label={copied ? "Copied" : label}
        variant="secondary"
        onPress={() => {
          void clipboard.writeText(url).then(() => setCopied(true));
        }}
      />
    </View>
  );
}

function Para({ children, center }: { children: ReactNode; center?: boolean }) {
  return (
    <Text variant="body" tone="secondary" style={[styles.para, center ? styles.center : null]}>
      {children}
    </Text>
  );
}

function B({ children }: { children: ReactNode }) {
  return <Text style={styles.bold}>{children}</Text>;
}

/** Renders **label** runs bold. */
function rich(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <B key={i}>{part.slice(2, -2)}</B> : part,
  );
}

/** The desktop shell's tab surface. */
export function InstallGuideScreen() {
  const nav = useNav();
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <InstallGuide onDone={() => nav.goView("today")} />
    </ScrollView>
  );
}

/** The mobile shell's pushed route: the guide under a nav bar. Back (and Done) step up to Home. */
export function InstallGuideRouteScreen() {
  const nav = useNav();
  return (
    <View style={styles.root}>
      <NavBar title="Add to Home Screen" />
      <ScrollView contentContainerStyle={styles.page}>
        <InstallGuide onDone={nav.back} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  page: { padding: space.xl, paddingBottom: space.xxl, alignItems: "center" },
  body: { width: "100%", maxWidth: 520, gap: space.xl },
  hero: { alignItems: "center", gap: space.md, paddingTop: space.lg },
  center: { textAlign: "center" },
  para: { lineHeight: 21 },
  bold: { fontWeight: font.weight.semibold, color: colors.textPrimary },
  eraRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  steps: {
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.ml,
    paddingVertical: space.ml,
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stepNumberText: { fontSize: font.size.sm, fontWeight: font.weight.semibold },
  glyph: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  addressBar: {
    width: 28,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceCard,
    justifyContent: "center",
    paddingLeft: 2,
  },
  addressBarButton: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.info },
  moreCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceCard,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { flex: 1, minWidth: 0, lineHeight: 21 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.md },
});
