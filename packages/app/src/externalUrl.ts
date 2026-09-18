import { Linking } from "react-native";

// Opening a link "out there" — a sign-in page, a sign-up page, docs — must land in the user's real
// browser, never in the app's own webview. Linking.openURL does that on mobile and on the web; the
// desktop shell's webview needs its own opener (the Wails runtime) and registers it here.
let opener: (url: string) => Promise<void> = (url) => Linking.openURL(url);

/** Shell hook: how this platform opens a URL in the system browser. */
export function setExternalUrlOpener(next: (url: string) => Promise<void>): void {
  opener = next;
}

/** Open a URL in the system browser. */
export function openExternalUrl(url: string): Promise<void> {
  return opener(url);
}
