// ============================================================
// Compliance requests, the public parent forms: the HTTP edge. What the three public routes (/api/compliance/public/[slug]/code, /verify, /submit) do the
// same way. SERVER ONLY. Answers are JSON, `Cache-Control: no-store`, and say what happened in a CODE (the page words it in the parent's language); they
// never carry an address back (except the one the person just typed, masked), a link, a stored answer, or anything about whether an email, a phone
// number or a request exists.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { readBodyCapped } from "@/lib/net/read-capped";
import { checkSharedRateLimit } from "@/lib/rate-limit-shared";
import { turnstileEnabled, verifyTurnstile } from "@/lib/sign/registration/turnstile";

import { realNoticeDeps } from "../service/notices";
import type { CodeRequestOutcome, CodeVerifyOutcome, PublicEnv, SubmitOutcome, UploadedPart } from "./service";
import { PUBLIC_MAX_BODY_BYTES } from "./validate";
import { sessionCookie } from "./session";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function publicJson(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

/** What the public routes run with: the service-role client (a stranger has no login; every read and write is scoped to the form's workspace), the shared limiter, Turnstile and the real sender. */
export function publicEnv(): PublicEnv {
  return {
    admin: supabaseAdmin() as SupabaseClient,
    now: () => new Date(),
    limit: async (key, limit, windowMs) => (await checkSharedRateLimit(key, { limit, windowMs })).success,
    captcha: { enabled: turnstileEnabled(), verify: (token, ip) => verifyTurnstile(token, ip) },
    notices: realNoticeDeps,
  };
}

/** A small JSON object body, or null when it is too large or not an object. */
export async function readSmallJson(request: Request, maxBytes = 8_000): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const raw = await readBodyCapped(request, maxBytes);
  if (raw === null) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(raw) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function codeResponse(o: CodeRequestOutcome): NextResponse {
  switch (o.kind) {
    case "ok":
      return publicJson({ ok: true, emailMasked: o.emailMasked });
    case "invalid_email":
      return publicJson({ code: "invalid_email" }, 400);
    case "captcha_failed":
      return publicJson({ code: "captcha_failed" }, 400);
    case "rate_limited":
      return publicJson({ code: "rate_limited" }, 429);
    case "send_failed":
      return publicJson({ code: "send_failed" }, 503);
    case "not_configured":
      return publicJson({ code: "unavailable" }, 503);
    default:
      return publicJson({ code: "not_found" }, 404);
  }
}

export function verifyResponse(o: CodeVerifyOutcome): NextResponse {
  switch (o.kind) {
    case "ok":
      return publicJson({ ok: true, emailMasked: o.emailMasked }, 200, { "Set-Cookie": sessionCookie(o.cookie.name, o.cookie.value, o.cookie.maxAgeSeconds) });
    case "wrong":
      return publicJson({ code: "wrong_code", attemptsLeft: o.attemptsLeft }, 400);
    case "expired":
      return publicJson({ code: "expired" }, 400);
    case "too_many_attempts":
      return publicJson({ code: "too_many_attempts" }, 400);
    case "no_code":
      return publicJson({ code: "no_code" }, 400);
    case "invalid_email":
      return publicJson({ code: "invalid_email" }, 400);
    case "rate_limited":
      return publicJson({ code: "rate_limited" }, 429);
    case "not_configured":
      return publicJson({ code: "unavailable" }, 503);
    default:
      return publicJson({ code: "not_found" }, 404);
  }
}

export function submitResponse(o: SubmitOutcome): NextResponse {
  switch (o.kind) {
    case "ok":
      return publicJson({ ok: true, reference: o.reference });
    case "declined":
      return publicJson({ ok: true, declined: true });
    case "invalid":
      return publicJson({ code: "invalid", problems: o.problems }, 400);
    case "retry":
      return publicJson({ code: o.code, token: o.token }, 400);
    case "session_invalid":
      return publicJson({ code: "session_invalid" }, 401);
    case "rate_limited":
      return publicJson({ code: "rate_limited" }, 429);
    case "failed":
      return publicJson({ code: "failed" }, 503);
    case "not_configured":
      return publicJson({ code: "unavailable" }, 503);
    default:
      return publicJson({ code: "not_found" }, 404);
  }
}

export type MultipartRead = { ok: true; payload: Record<string, unknown>; files: { letter?: UploadedPart | null; proof?: UploadedPart | null } } | { ok: false; status: 400 | 413; code: "too_large" | "bad_request" };

/**
 * The submission as it arrives: a multipart post with a JSON `payload` and at most two files (`letter`, `proof`). The body is read a piece at a time
 * and stopped at the cap (a body that lies about its length never fills the server's memory); a file over its own limit is refused before it is read.
 */
export async function readSubmission(request: Request): Promise<MultipartRead> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(type)) return { ok: false, status: 400, code: "bad_request" };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PUBLIC_MAX_BODY_BYTES) return { ok: false, status: 413, code: "too_large" };
  const raw = await readBodyCapped(request, PUBLIC_MAX_BODY_BYTES);
  if (raw === null) return { ok: false, status: 413, code: "too_large" };
  let form: FormData;
  try {
    form = await new Response(raw as BodyInit, { headers: { "content-type": type } }).formData();
  } catch {
    return { ok: false, status: 400, code: "bad_request" };
  }
  let payload: Record<string, unknown> = {};
  const p = form.get("payload");
  if (typeof p === "string" && p.length <= 40_000) {
    try {
      const v = JSON.parse(p);
      if (v && typeof v === "object" && !Array.isArray(v)) payload = v as Record<string, unknown>;
    } catch {
      return { ok: false, status: 400, code: "bad_request" };
    }
  } else if (p !== null) {
    return { ok: false, status: 400, code: "bad_request" };
  }
  const files: { letter?: UploadedPart | null; proof?: UploadedPart | null } = {};
  for (const id of ["letter", "proof"] as const) {
    const f = form.get(id);
    if (f && typeof f !== "string") {
      // bytes over the limit are passed on as they are: the service answers with a problem for the field (the size is checked there, once)
      files[id] = { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name || "file" };
    }
  }
  return { ok: true, payload, files };
}
