// ============================================================
// Compliance requests: the HTTP edge. What every /api/compliance route does the same way, so each route file is only what is particular to it.
//
//   complianceStaff   requireCapability('menu.compliance') (the operator's `compliance` flag removes the capability, so a workspace with the flag off
//                     gets a 403 here), then the capability this route needs, a rate limit per person, and the service-role client scoped to the
//                     caller's workspace with the caller's permissions as a `Viewer`
//
// Answers are JSON `{ error: <code>, code: <code>, issues? }` with the status of STATUS_OF. Nothing the database, the network or the key ring said is
// passed through. Every answer, including a file, is `Cache-Control: no-store`.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { readBodyCapped } from "@/lib/net/read-capped";
import { checkRateLimit } from "@/lib/rate-limit";

import { ComplianceError, STATUS_OF } from "./errors";
import type { ComplianceCaller } from "./service/rows";
import type { ErrorCode } from "./types";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface ComplianceCall {
  admin: SupabaseClient;
  caller: ComplianceCaller;
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function failure(code: ErrorCode, issues?: { field?: string; code: string }[]): NextResponse {
  return json({ error: code, code, ...(issues ? { issues } : {}) }, STATUS_OF[code]);
}

/** 429 in this module's shape (a code, no-store, Retry-After). */
export function rateLimited(resetAtMs: number): NextResponse {
  const res = failure("rate_limited");
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000))));
  return res;
}

export interface StaffOptions {
  /** Name of the rate-limit bucket (routes with different costs do not share one). */
  bucket: string;
  /** Requests per minute per person for this route (default 60). */
  perMinute?: number;
  /** A capability this route needs in addition to menu.compliance (for example compliance.manage). */
  need?: string;
  /** Any one of these (for example the routes the officer or the Head may call). */
  needAny?: readonly string[];
}

export async function complianceStaff(opts: StaffOptions, handler: (call: ComplianceCall) => Promise<Response>): Promise<Response> {
  try {
    const auth = await requireCapability("menu.compliance");
    if (opts.need && !auth.capabilities.has(opts.need)) return failure("forbidden");
    if (opts.needAny && !opts.needAny.some((c) => auth.capabilities.has(c))) return failure("forbidden");
    const rate = checkRateLimit(`compliance:${auth.userId}:${opts.bucket}`, { limit: opts.perMinute ?? 60, windowMs: 60_000 });
    if (!rate.success) return rateLimited(rate.reset);
    const caps = auth.capabilities;
    const caller: ComplianceCaller = {
      accountId: auth.accountId,
      userId: auth.userId,
      viewer: {
        userId: auth.userId,
        canReview: caps.has("compliance.review"),
        canApprove: caps.has("compliance.approve"),
        canReveal: caps.has("compliance.reveal"),
        canExecute: caps.has("compliance.execute"),
        canManage: caps.has("compliance.manage"),
      },
    };
    return await handler({ admin: supabaseAdmin(), caller });
  } catch (err) {
    return answer(err);
  }
}

/** A thrown error as an answer: ours with its code, the sign-in and permission errors in the app's usual shape, anything else as a plain 500. */
export function answer(err: unknown): NextResponse {
  if (err instanceof ComplianceError) return failure(err.code, err.issues);
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return toErrorResponse(err);
  console.error("[compliance] unexpected error:", err instanceof Error ? err.name : "unknown");
  return failure("server_error");
}

/** Parse a small JSON object body, or throw `invalid_request`. */
export async function readJsonBody<T = Record<string, unknown>>(request: Request, maxBytes = 200_000): Promise<T> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ComplianceError("invalid_request", "That request is too large.", 413);
  const raw = await readBodyCapped(request, maxBytes);
  if (raw === null) throw new ComplianceError("invalid_request", "That request is too large.", 413);
  try {
    const v = JSON.parse(new TextDecoder().decode(raw) || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return v as T;
  } catch {
    throw new ComplianceError("invalid_request", "That request could not be read.", 400);
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
