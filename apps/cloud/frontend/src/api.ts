// Thin client for the cloud API (served at /api/v1). The access token is persisted in
// localStorage so a reload keeps the session; refresh-token rotation is out of scope for
// this portal shell (the product apps own long-lived sessions).

const TOKEN_KEY = "companion.cloud.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req(path: string, opts: RequestInit = {}): Promise<any> {
  const headers = new Headers(opts.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (opts.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`/api/v1${path}`, { ...opts, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

// ---- auth -----------------------------------------------------------------

export type AuthResult = { token: string; userId: string };

export function register(
  email: string,
  password: string,
  firstName = "",
  lastName = "",
): Promise<AuthResult> {
  return req("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, firstName, lastName }),
  });
}

export function login(email: string, password: string): Promise<AuthResult> {
  return req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

// forgotPassword requests a reset link. Always resolves (the server never reveals whether
// the address is registered).
export function forgotPassword(email: string): Promise<unknown> {
  return req("/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
}

// resetPassword sets a new password from a reset token (from the emailed link).
export function resetPassword(token: string, newPassword: string): Promise<unknown> {
  return req("/auth/reset", { method: "POST", body: JSON.stringify({ token, newPassword }) });
}

// ---- account (shared with the open-core server) ---------------------------

export type Account = {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
};

export function getAccount(): Promise<Account> {
  return req("/account");
}

// sendVerification issues + emails a fresh verification link for the signed-in user.
export function sendVerification(): Promise<unknown> {
  return req("/auth/verify/send", { method: "POST", body: JSON.stringify({}) });
}

// verifyEmail confirms an address from a token (from the emailed link); no session needed.
export function verifyEmail(token: string): Promise<unknown> {
  return req("/auth/verify", { method: "POST", body: JSON.stringify({ token }) });
}

export function updateProfile(firstName: string, lastName: string): Promise<unknown> {
  return req("/account/profile", { method: "POST", body: JSON.stringify({ firstName, lastName }) });
}

export function updateEmail(email: string): Promise<unknown> {
  return req("/account/email", { method: "POST", body: JSON.stringify({ email }) });
}

// updatePassword rotates the session server-side; persist the new token it returns so the
// current device stays signed in.
export async function updatePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await req("/account/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (res.token) setToken(res.token);
}

// ---- billing --------------------------------------------------------------

export type Subscription = { status: string; currentPeriodEnd?: string };

export function getSubscription(): Promise<Subscription> {
  return req("/billing/subscription");
}

export function startCheckout(): Promise<{ url: string }> {
  return req("/billing/checkout", { method: "POST" });
}

export type Invoice = {
  number: string;
  amount: number; // minor units (cents)
  currency: string;
  status: string;
  created: number; // unix seconds
  url: string;
  pdf: string;
};

export function getInvoices(): Promise<{ invoices: Invoice[] }> {
  return req("/billing/invoices");
}

export type Upcoming = { amount: number; currency: string; dueAt: number } | null;

export function getUpcoming(): Promise<{ upcoming: Upcoming }> {
  return req("/billing/upcoming");
}

// ---- admin ----------------------------------------------------------------

// isAdmin resolves true only when the session belongs to an admin. The endpoint 404s for
// everyone else, so a rejected request means "not an admin".
export async function isAdmin(): Promise<boolean> {
  try {
    await req("/admin/me");
    return true;
  } catch {
    return false;
  }
}

export type PeriodCounts = { today: number; week: number; month: number; all: number };

export type StripeStatus = {
  apiKeyConfigured: boolean;
  apiReachable: boolean;
  webhookConfigured: boolean;
  lastWebhookAt: string;
};

export type Dashboard = {
  users: PeriodCounts;
  subscriptions: PeriodCounts;
  stripe: StripeStatus;
};

export function adminDashboard(): Promise<Dashboard> {
  return req("/admin/dashboard");
}

export type AdminUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: string;
  isAdmin: boolean;
  emailVerified: boolean;
  subscriptionStatus: string;
};

export function adminUsers(): Promise<{ users: AdminUser[] }> {
  return req("/admin/users");
}

export type AdminSubscription = {
  userId: string;
  email: string;
  plan: string;
  source: string;
  status: string;
  currentPeriodEnd: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  createdAt: string;
};

export function adminUser(id: string): Promise<{ user: AdminUser; subscription: AdminSubscription | null }> {
  return req(`/admin/users/${id}`);
}

export function adminUpdateUser(
  id: string,
  patch: Partial<{ email: string; firstName: string; lastName: string; isAdmin: boolean }>,
): Promise<{ user: AdminUser; subscription: AdminSubscription | null }> {
  return req(`/admin/users/${id}`, { method: "POST", body: JSON.stringify(patch) });
}

export function adminSubscriptions(): Promise<{ subscriptions: AdminSubscription[] }> {
  return req("/admin/subscriptions");
}

export function adminUserInvoices(id: string): Promise<{ invoices: Invoice[] }> {
  return req(`/admin/users/${id}/invoices`);
}

type UserResult = { user: AdminUser; subscription: AdminSubscription | null };

// adminGrantFree gives a user a perpetual free subscription.
export function adminGrantFree(id: string): Promise<UserResult> {
  return req(`/admin/users/${id}/grant-free`, { method: "POST" });
}

// adminRevoke cancels an admin-granted free subscription.
export function adminRevoke(id: string): Promise<UserResult> {
  return req(`/admin/users/${id}/revoke`, { method: "POST" });
}

// adminResendVerification re-sends the email verification link for a user.
export function adminResendVerification(id: string): Promise<{ sent: boolean; verified: boolean }> {
  return req(`/admin/users/${id}/resend-verification`, { method: "POST" });
}

// ---- admin: subscription plans --------------------------------------------

export type Plan = {
  id: string;
  name: string;
  stripePriceId: string;
  amount: number;
  currency: string;
  interval: string;
  active: boolean;
};

export function adminPlans(): Promise<{ plans: Plan[] }> {
  return req("/admin/plans");
}

// A recurring Stripe price an admin can turn into a plan.
export type StripePrice = {
  priceId: string;
  productName: string;
  nickname: string;
  amount: number;
  currency: string;
  interval: string;
};

export function adminStripePrices(): Promise<{ prices: StripePrice[] }> {
  return req("/admin/stripe/prices");
}

export function adminCreatePlan(body: {
  id: string;
  name: string;
  stripePriceId: string;
  amount: number;
  currency: string;
  interval: string;
}): Promise<{ plans: Plan[] }> {
  return req("/admin/plans", { method: "POST", body: JSON.stringify(body) });
}

export function adminDeletePlan(id: string): Promise<{ plans: Plan[] }> {
  return req(`/admin/plans/${id}`, { method: "DELETE" });
}

// ---- config ---------------------------------------------------------------

// getConfig returns public runtime config, including the sync base URL clients enter in
// the Companion app.
export function getConfig(): Promise<{ syncUrl: string }> {
  return req("/config");
}

// ---- helpers --------------------------------------------------------------

export function formatMoney(minorUnits: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(minorUnits / 100);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
