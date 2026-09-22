/** Companion Cloud endpoints (PLAN §7).
 *
 *  The portal address is a build-time setting, so a staging or otherwise self-branded build
 *  can point the "Companion Cloud" door somewhere else:
 *
 *      EXPO_PUBLIC_PORTAL_URL=https://portal.staging.example.com
 *
 *  Expo inlines EXPO_PUBLIC_* on mobile; the web and desktop Vite configs `define` the same
 *  expression. Every bundler rewrites the literal `process.env.EXPO_PUBLIC_PORTAL_URL` text
 *  below, so do not alias, destructure or guard it. Unset or empty means production. */
declare const process: { env: { EXPO_PUBLIC_PORTAL_URL?: string } };

const DEFAULT_PORTAL_URL = "https://portal.companionapp.cloud";

function portalUrl(): string {
  const raw = (process.env.EXPO_PUBLIC_PORTAL_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_PORTAL_URL;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** The portal where cloud accounts are created and billed. */
export const CLOUD_PORTAL_URL = portalUrl();

/** The hosted cloud's sync API: the portal serves it under /api (see apps/cloud syncAPIURL). */
export const CLOUD_BASE_URL = `${CLOUD_PORTAL_URL}/api`;

/** The portal's host, for copy ("register at portal.companionapp.cloud"). */
export const CLOUD_PORTAL_LABEL = CLOUD_PORTAL_URL.replace(/^https?:\/\//i, "");
