// ============================================================
// Registration page: the optional Cloudflare Turnstile check.
//
// Off unless BOTH keys are set:
//   NEXT_PUBLIC_TURNSTILE_SITE_KEY   the public key the page's widget uses
//   TURNSTILE_SECRET_KEY             the secret the server verifies the widget's token with (never sent to a browser)
// With both set, the page shows the widget and the submit route refuses a submission whose token Cloudflare
// does not confirm. With either missing nothing changes: the rate limits, the hidden field and the signed form
// token are the defence.
//
// The keys are read from the server's environment when the page is drawn (the site key is handed to the page as
// a prop), so setting them needs a restart, not a rebuild. The check calls one fixed Cloudflare address through
// the app's guarded fetch (lib/net/safe-fetch.ts), and fails closed: a token that cannot be checked is refused.
// ============================================================

import { pinnedFetch } from "@/lib/net/safe-fetch";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// read by name at run time, so the value is the server's environment and not whatever was inlined at build
const SITE_KEY_VAR = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";
const SECRET_VAR = "TURNSTILE_SECRET_KEY";

const read = (name: string, env: Record<string, string | undefined>): string | null => env[name]?.trim() || null;

/** The key for the page's widget, or null when Turnstile is off (either key missing). */
export function turnstileSiteKey(env: Record<string, string | undefined> = process.env): string | null {
  return read(SITE_KEY_VAR, env) && read(SECRET_VAR, env) ? read(SITE_KEY_VAR, env) : null;
}

export const turnstileEnabled = (env: Record<string, string | undefined> = process.env): boolean => turnstileSiteKey(env) !== null;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Does Cloudflare confirm this token? False for a missing token, an answer that is not a success, or any failure
 * to ask (network, timeout, a bad reply): a check that cannot be made does not let a submission through.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip: string | null,
  opts: { env?: Record<string, string | undefined>; fetcher?: Fetcher } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  const secret = read(SECRET_VAR, env);
  if (!secret || !token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  try {
    const res = await (opts.fetcher ?? pinnedFetch)(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const answer = (await res.json()) as { success?: unknown };
    return answer.success === true;
  } catch (err) {
    console.error("[sign] Turnstile could not be checked:", err instanceof Error ? err.message : err);
    return false;
  }
}
