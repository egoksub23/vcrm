// ============================================================
// KYC review: the HTTP edge. What every /api/kyc route does the same way, so each route file is only what is particular to it.
//
//   kycStaff   requireCapability (menu.kyc; the operator's `kyc` flag removes the capability, so a workspace with the flag off gets a 403 here),
//              a rate limit per person, an optional admin-or-owner check, the service-role client scoped to the caller's workspace
//
// Answers are JSON `{ error: <code>, code: <code> }` with the status of STATUS_OF; nothing the back end, the database or the network said is passed
// through. Every answer, including an image, is `Cache-Control: no-store`.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { checkRateLimit } from "@/lib/rate-limit";

import { kycRuntime, type KycRuntime } from "./runtime";
import { STATUS_OF, type KycCaller } from "./service";
import type { KycErrorCode } from "./types";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface KycCall {
  admin: SupabaseClient;
  caller: KycCaller;
  runtime: KycRuntime;
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function failure(code: KycErrorCode): NextResponse {
  return json({ error: code, code }, STATUS_OF[code]);
}

/** 429 in this module's shape (a code, no-store, Retry-After). */
export function rateLimited(resetAtMs: number): NextResponse {
  const res = failure("rate_limited");
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000))));
  return res;
}

export interface StaffOptions {
  /** Requests per minute per person for this route (default 60). */
  perMinute?: number;
  /** Only an admin or owner of the workspace. */
  adminOnly?: boolean;
  /** Name of the rate-limit bucket (routes with different costs do not share one). */
  bucket: string;
}

export async function kycStaff(opts: StaffOptions, handler: (call: KycCall) => Promise<NextResponse>): Promise<NextResponse> {
  try {
    const auth = await requireCapability("menu.kyc");
    const isAdmin = hasMinRole(auth.role, "admin");
    if (opts.adminOnly && !isAdmin) return failure("forbidden");
    const rate = checkRateLimit(`kyc:${auth.userId}:${opts.bucket}`, { limit: opts.perMinute ?? 60, windowMs: 60_000 });
    if (!rate.success) return rateLimited(rate.reset);
    const caller: KycCaller = {
      accountId: auth.accountId,
      userId: auth.userId,
      canView: auth.capabilities.has("kyc.view"),
      canReveal: auth.capabilities.has("kyc.reveal"),
      isAdmin,
    };
    return await handler({ admin: supabaseAdmin(), caller, runtime: kycRuntime() });
  } catch (err) {
    return toErrorResponse(err);
  }
}
