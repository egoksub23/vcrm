// ============================================================
// What the public registration route runs with: the service-role client (a stranger has no login, and every
// read and write in registration.ts is scoped to the form's workspace), the real delivery, the shared limiter
// (limits that hold across app instances) and the Turnstile check when it is configured. A module of its own so
// the route file stays a thin edge and the tests can pass their own.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";

import { originOf, sharedLimit } from "../http";
import { realDeps } from "../notify";
import { turnstileEnabled, verifyTurnstile } from "../registration/turnstile";
import type { SubmitEnv } from "./registration";

export function registrationEnv(request: Request): SubmitEnv {
  return {
    admin: supabaseAdmin(),
    origin: originOf(request),
    deps: realDeps,
    now: () => new Date(),
    limit: sharedLimit,
    captcha: { enabled: turnstileEnabled(), verify: (token, ip) => verifyTurnstile(token, ip) },
  };
}
