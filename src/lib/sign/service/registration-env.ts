// ============================================================
// What the public registration route runs with: the service-role client (a stranger has no login, and every
// read and write in registration.ts is scoped to the form's workspace), the real delivery, the shared limiter
// (limits that hold across app instances) and the Turnstile check when it is configured. A module of its own so
// the route file stays a thin edge and the tests can pass their own.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";

import { publicOrigin } from "@/lib/site-url";

import { sharedLimit } from "../http";
import { realDeps } from "../notify";
import { turnstileEnabled, verifyTurnstile } from "../registration/turnstile";
import type { SubmitEnv } from "./registration";

/**
 * The address on the links the registration emails carry is the deployment's own (NEXT_PUBLIC_SITE_URL), never the one the request arrived on:
 * this route has no login, so a caller who chose the Host header would otherwise choose where a stranger's emailed link points.
 * With no address configured `origin` is empty and the service answers "not available".
 */
export function registrationEnv(): SubmitEnv {
  return {
    admin: supabaseAdmin(),
    origin: publicOrigin(),
    deps: realDeps,
    now: () => new Date(),
    limit: sharedLimit,
    captcha: { enabled: turnstileEnabled(), verify: (token, ip) => verifyTurnstile(token, ip) },
  };
}
