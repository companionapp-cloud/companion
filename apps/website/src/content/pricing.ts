// What Companion Cloud costs and where the two sync paths lead. Shared by the pricing page
// and the landing page's sync section so the site never quotes two different numbers.
//
// The price charged at checkout is the Stripe price behind the cloud's active plan (see
// apps/cloud/plans.go) — this is only what the site says out loud, so keep the two in step.
export const CLOUD_PRICE = "$1.99";
export const CLOUD_CURRENCY = "USD";
export const CLOUD_PERIOD = "Per account, per month";

/** The cloud portal: where accounts are created, subscribed, and managed. */
export const CLOUD_PORTAL_URL = "https://portal.companionapp.cloud";

export const CLOUD_DOCS_HREF = "/docs/using-our-cloud";
export const SELF_HOSTING_HREF = "/docs/self-hosting";
