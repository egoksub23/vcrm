// ============================================================
// POST /api/sign/register/[slug]   (public: a registration page, no login)
//
// What the page at /r/<slug> posts: the details, the agreement, the page's signed form token, the hidden
// field and, when Turnstile is on, its token. Everything that decides what happens is in
// lib/sign/service/registration.ts; this file is only the edge that turns its answer into a response.
//
// Answers (always JSON, never cached):
//   200 { ok: true }                              taken (a first time, a repeat, or a script: the page cannot tell)
//   400 { code: "invalid", problems }             which details are wrong and why
//   400 { code, token }                           token_invalid | token_expired | token_too_fast | captcha_failed: try again with this fresh token
//   404 { code: "not_found" }                     unknown, switched off, or Doc Sign off: one answer for all
//   429 { code: "rate_limited" | "form_cap" }     too many from this address or for this form; or the day's cap is full
//   503 { code: "send_failed" | "try_later" | "unavailable" }
//                                                 could not be completed on our side (the details are saved, or are not);
//                                                 the server has no key to sign with
//
// The body is small (20 KB at most). It never carries a link or an address back, and never says whether an email
// was already known.
// ============================================================
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { failure, json, readJson } from "@/lib/sign/http";
import { submitRegistration, type SubmitOutcome } from "@/lib/sign/service/registration";
import { registrationEnv } from "@/lib/sign/service/registration-env";

type Params = { params: Promise<{ slug: string }> };

function respond(outcome: SubmitOutcome) {
  switch (outcome.kind) {
    case "ok":
      return json({ ok: true });
    case "invalid":
      return json({ code: "invalid", error: "Some details need a change.", problems: outcome.problems }, 400);
    case "retry":
      return json({ code: outcome.code, error: "Please try again.", token: outcome.token }, 400);
    case "cap":
      return json({ code: "form_cap", error: "This page is not taking more today." }, 429);
    case "rate_limited":
      return json({ code: "rate_limited", error: "Too many tries. Please wait and try again." }, 429);
    case "failed":
      // "send_failed": the details are saved and the workspace will be in touch; "try_later": nothing was saved
      return json({ code: outcome.saved ? "send_failed" : "try_later", error: "This could not be completed right now." }, 503);
    case "not_configured":
      return json({ code: "unavailable", error: "This page is not available right now." }, 503);
    default:
      return json({ code: "not_found", error: "This page is not available." }, 404);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    // before anything is looked up: a cheap per-process ceiling per address, so an unknown address cannot be hammered for free
    // (the budgets that count in the database, per address and per form, are in the service)
    const ip = clientIp(request.headers);
    const early = checkRateLimit(`sign-register:${ip}`, { limit: 90, windowMs: 60_000 });
    if (!early.success) return rateLimitResponse(early);
    const { slug } = await params;
    const body = await readJson(request, 20_000);
    return respond(await submitRegistration(registrationEnv(request), { slug, body, ip, userAgent: request.headers.get("user-agent") }));
  } catch (err) {
    return failure(err);
  }
}
