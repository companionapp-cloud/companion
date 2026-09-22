// iOS/iPadOS web-app install detection (PLAN §6.4, web push). Web Push reaches an iPhone or iPad
// only through a Home Screen web app (iOS 16.4+): in a Safari tab there is no Push API at all. So
// the app reads, from the user agent, whether it is running on iOS, in which browser, on which
// version, and whether it is already installed — enough to decide whether to offer installing and
// which steps to show.

export type IosDevice = "iphone" | "ipad";

/** Who is rendering the page. "in-app" is a social/news app's embedded browser, which can't add
 *  anything to the Home Screen. */
export type IosBrowser = "safari" | "chrome" | "edge" | "firefox" | "other" | "in-app";

export interface IosVersion {
  major: number;
  minor: number;
}

export interface IosEnv {
  device: IosDevice;
  browser: IosBrowser;
  /** The version the browser reports, or null when it can't be read. Safari's `Version/` token
   *  tracks iOS itself — and, unlike its OS token (frozen at 18_6, later 18_7, since iOS 26), it is
   *  honest. Chrome and Edge report the real OS; Firefox always says 18_7. */
  version: IosVersion | null;
  /** Running as an installed Home Screen web app. */
  standalone: boolean;
}

/** The first iOS/iPadOS release with Web Push for Home Screen web apps. */
export const IOS_WEB_PUSH_MIN: IosVersion = { major: 16, minor: 4 };


interface UaSource {
  userAgent: string;
  maxTouchPoints: number;
  /** min(screen width, height) in CSS px, to tell an iPhone asking for the desktop site (which
   *  reads like an iPad) from an iPad. */
  shortSide: number;
  standalone: boolean;
}

function currentSource(): UaSource | null {
  if (typeof navigator === "undefined" || typeof window === "undefined") return null;
  const screen = window.screen;
  return {
    userAgent: navigator.userAgent ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    shortSide: screen ? Math.min(screen.width, screen.height) : 0,
    standalone: isStandalone(),
  };
}

/** Running as an installed web app: the manifest's display mode, or iOS's own flag. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  try {
    return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  } catch {
    return false;
  }
}

/** Reads iOS/iPadOS from the environment (or the given source); null on every other platform. */
export function detectIos(source: UaSource | null = currentSource()): IosEnv | null {
  if (!source) return null;
  const ua = source.userAgent;
  let device: IosDevice | null = null;
  if (/\b(iPhone|iPod)\b/.test(ua)) device = "iphone";
  else if (/\biPad\b/.test(ua)) device = "ipad";
  // iPadOS Safari asks for desktop sites by default, so it reads as a Mac — one with a touch screen.
  // An iPhone that requested the desktop site does the same; its short side gives it away.
  else if (/\bMacintosh\b/.test(ua) && source.maxTouchPoints > 1) device = source.shortSide > 0 && source.shortSide < 600 ? "iphone" : "ipad";
  if (!device) return null;
  const browser = browserOf(ua);
  return { device, browser, version: versionOf(ua, browser), standalone: source.standalone };
}

function browserOf(ua: string): IosBrowser {
  if (/\bCriOS\//.test(ua)) return "chrome";
  if (/\bEdgiOS\//.test(ua)) return "edge";
  if (/\bFxiOS\//.test(ua)) return "firefox";
  // Embedded browsers of apps (Facebook, Instagram, the Google app, …). Most drop Safari's token.
  if (/\b(FBAN|FBAV|FBIOS|Instagram|GSA|LinkedInApp|Line|MicroMessenger|Snapchat|musical_ly|Twitter|Pinterest)\b/.test(ua)) return "in-app";
  if (/\b(OPiOS|OPT|YaBrowser|DuckDuckGo|Brave)\b/.test(ua)) return "other";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return "safari";
  // No Safari token at all: a bare WKWebView inside some app (or an installed web app, which the
  // caller knows from `standalone`).
  return /\bSafari\//.test(ua) ? "other" : "in-app";
}

function versionOf(ua: string, browser: IosBrowser): IosVersion | null {
  // Safari's own version tracks the OS release (Safari 17.4 ships with iOS 17.4, Safari 26 with
  // iOS 26) and stayed honest when iOS 26 froze the OS token; the other browsers' OS token is
  // theirs to set, so for them it comes first.
  const safari = /\bVersion\/(\d+)(?:\.(\d+))?/.exec(ua);
  const os = /\b(?:iPhone|CPU) OS (\d+)_(\d+)/.exec(ua);
  const [first, second] = browser === "chrome" || browser === "edge" || browser === "firefox" ? [os, safari] : [safari, os];
  const m = first ?? second;
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0) } : null;
}

/** Which Safari the install steps are written for: iOS 27's Compact layout keeps Share in the Page
 *  menu, iOS 26's behind "···", and earlier releases in the toolbar. */
export type SafariEra = "27" | "26" | "legacy";

export function safariEra(version: IosVersion | null): SafariEra {
  if (!version || version.major >= 27) return "27";
  return version.major >= 26 ? "26" : "legacy";
}

export function atLeast(v: IosVersion, min: IosVersion): boolean {
  return v.major > min.major || (v.major === min.major && v.minor >= min.minor);
}

/** Whether this iOS can get Web Push once installed. An unreadable version gets the benefit of
 *  the doubt: a banner offered in error costs one tap to dismiss. */
export function iosSupportsWebPush(env: IosEnv): boolean {
  return env.version === null || atLeast(env.version, IOS_WEB_PUSH_MIN);
}

// --- the prompt's dismissal ------------------------------------------------------------------

const DISMISS_KEY = "companion.installPrompt.dismissedAt";
/** How long a dismissed install banner stays away before offering once more. */
export const INSTALL_PROMPT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

export function installPromptDismissed(now = Date.now()): boolean {
  try {
    const at = Number(globalThis.localStorage?.getItem(DISMISS_KEY) ?? "");
    return Number.isFinite(at) && at > 0 && now - at < INSTALL_PROMPT_SNOOZE_MS;
  } catch {
    return false;
  }
}

export function dismissInstallPrompt(now = Date.now()): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, String(now));
  } catch {
    /* storage unavailable: the banner comes back next launch */
  }
}

/** Whether to offer installing: iOS/iPadOS new enough for Web Push, in a browser (not yet the
 *  installed app), and not recently dismissed. */
export function shouldOfferInstall(env: IosEnv | null = detectIos()): env is IosEnv {
  return !!env && !env.standalone && iosSupportsWebPush(env) && !installPromptDismissed();
}
