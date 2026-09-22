import { useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { BrandMark, Button, Icon, Text, colors, icon, radius, shadow, space, useDensity, type IconName, type PressState } from "@companion/design-system";
import { Overlay } from "../Overlay";
import { openExternalUrl } from "../externalUrl";
import { CLOUD_PORTAL_LABEL, CLOUD_PORTAL_URL } from "../cloud";
import { docsUrl } from "./links";
import { useOnboardingState } from "./OnboardingState";

// Over the status bar too, in any orientation (native only; not in the shared RN typing).
const fullScreen = { statusBarTranslucent: true, supportedOrientations: ["portrait", "landscape"] } as Record<string, unknown>;

// The welcome sheet: three short pages every user reads once before the app opens to them (the
// app loads underneath, out of reach). The last page asks whether they want the tutorials. What
// they read, and their answer, sync like the tutorials themselves.

interface Page {
  icon: IconName | "brand";
  title: string;
  body: string;
  links?: { label: string; url: string }[];
}

const PAGES: Page[] = [
  {
    icon: "brand",
    title: "Welcome to Companion",
    body: "A productivity app for your notes, your tasks and the ideas that connect them.",
  },
  {
    icon: "refresh",
    title: "Sync is off to start",
    body: `Everything stays on this device until you turn on sync. Subscribe at ${CLOUD_PORTAL_LABEL}, or host your own sync server.`,
    links: [
      { label: "Companion Cloud", url: CLOUD_PORTAL_URL },
      { label: "Host your own", url: docsUrl("self-hosting") },
    ],
  },
  {
    icon: "compass",
    title: "A tutorial for every tool",
    body: "Each tool has a short tutorial that shows the first time you open it. Do you want to enable tutorials?",
  },
];

/** Shows the welcome sheet until the user has read it (nothing, once they have). */
export function WelcomeSheet() {
  const { loaded, welcomeSeen } = useOnboardingState();
  if (!loaded || welcomeSeen) return null;
  return <WelcomeCard />;
}

function WelcomeCard() {
  const { finishWelcome } = useOnboardingState();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const last = page === PAGES.length - 1;
  const p = PAGES[page];
  const cardRef = useRef<HTMLElement | null>(null);
  // Dense buttons with a pointer; touch-sized ones (the density default) in the phone layout,
  // where the last page's two answers stack full width, since they don't fit side by side.
  const touch = useDensity() === "touch";
  const size = touch ? undefined : "sm";
  const answers = [
    <Button key="yes" label="Enable tutorials" size={size} fullWidth={touch} disabled={busy} onPress={() => finish(true)} />,
    <Button key="no" label="No thanks" variant="secondary" size={size} fullWidth={touch} disabled={busy} onPress={() => finish(false)} />,
  ];

  const finish = (tutorials: boolean) => {
    if (busy) return;
    setBusy(true);
    void finishWelcome(tutorials).finally(() => setBusy(false));
  };

  // Keys: arrows page through, Enter takes the main button. There is no way out but through, and
  // nothing reaches the app behind.
  const keys = useRef({ page, last, busy, finish });
  keys.current = { page, last, busy, finish };
  useEffect(() => {
    if (typeof window === "undefined" || !window.addEventListener) return;
    // Nothing behind the sheet keeps focus.
    (document.activeElement as HTMLElement | null)?.blur?.();
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      const inCard = !!cardRef.current && cardRef.current.contains(e.target as Node);
      const onControl = inCard && e.target !== cardRef.current;
      if (e.key === "ArrowRight" || (e.key === "Enter" && !onControl)) {
        e.preventDefault();
        e.stopPropagation();
        if (k.last) k.finish(true);
        else setPage(k.page + 1);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        setPage(Math.max(0, k.page - 1));
        return;
      }
      if (!inCard) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  useEffect(() => {
    cardRef.current?.focus?.({ preventScroll: true } as FocusOptions);
  }, [page]);

  const sheet = (
    <View style={styles.scrim}>
      <View ref={cardRef as never} aria-label={p.title} {...dialogProps} style={styles.card}>
        {p.icon === "brand" ? (
          <View style={styles.mark}>
            <BrandMark size={36} />
          </View>
        ) : (
          <View style={[styles.mark, styles.tile]}>
            <Icon name={p.icon} size={18} color={colors.textAccent} />
          </View>
        )}
        <Text variant="heading" style={styles.title}>
          {p.title}
        </Text>
        <Text variant="body" tone="secondary" style={styles.body}>
          {p.body}
        </Text>
        {p.links ? (
          <View style={styles.links}>
            {p.links.map((l) => (
              <ExternalLink key={l.label} label={l.label} url={l.url} />
            ))}
          </View>
        ) : null}
        {last && touch ? <View style={styles.stack}>{answers}</View> : null}
        <View style={styles.foot}>
          <View style={styles.dots} aria-label={`Page ${page + 1} of ${PAGES.length}`}>
            {PAGES.map((_, i) => (
              <View key={i} style={[styles.dot, i === page ? styles.dotOn : null]} />
            ))}
          </View>
          <View style={{ flex: 1 }} />
          {page > 0 ? <Button label="Back" variant="ghost" size={size} disabled={busy} onPress={() => setPage(page - 1)} /> : null}
          {!last ? <Button label="Next" size={size} onPress={() => setPage(page + 1)} /> : touch ? null : [...answers].reverse()}
        </View>
      </View>
    </View>
  );
  if (Platform.OS === "web") return <Overlay>{sheet}</Overlay>;
  return (
    // A modal over everything; Android's back button can't dismiss it (it has to be read through).
    <Modal transparent visible animationType="fade" {...fullScreen} onRequestClose={() => undefined}>
      {sheet}
    </Modal>
  );
}

function ExternalLink({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      onPress={() => void openExternalUrl(url).catch(() => undefined)}
      aria-label={`${label} (opens in your browser)`}
      style={({ hovered }: PressState) => [styles.link, hovered ? styles.linkHover : null]}
    >
      <Text variant="caption" tone="accent">
        {label}
      </Text>
      <Icon name="external" size={icon.sm} color={colors.textAccent} />
    </Pressable>
  );
}

// A focusable dialog, so keys land on it rather than on the app behind. Not in this RN typing,
// hence the cast.
const dialogProps = { role: "dialog", "aria-modal": true, focusable: true } as Record<string, unknown>;

const styles = {
  scrim: {
    position: (Platform.OS === "web" ? "fixed" : "absolute") as "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: space.xl,
    backgroundColor: colors.scrim,
    zIndex: 3000,
  },
  card: {
    width: 400,
    maxWidth: "100%" as const,
    padding: space.xl2,
    gap: space.sm,
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    outlineStyle: "none",
  } as Record<string, unknown>,
  // The page's mark: the app tile on the first page, an icon on a soft accent tile after.
  mark: { width: 36, height: 36, marginBottom: space.xs },
  tile: {
    borderRadius: radius.xl,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: colors.accentSoft,
  },
  title: { marginTop: space.xxs },
  body: { lineHeight: 19 },
  links: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.lg, marginTop: space.xxs },
  link: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, borderRadius: radius.sm },
  linkHover: { opacity: 0.8 },
  foot: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, marginTop: space.lg },
  stack: { gap: space.sm, marginTop: space.lg },
  dots: { flexDirection: "row" as const, gap: 5 },
  dot: { width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.borderDefault },
  dotOn: { backgroundColor: colors.accent },
};
