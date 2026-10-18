// ============================================================
// KYC review: what each route does, apart from the HTTP. Server only.
//
// Every function here follows the same order, and the order is the security model:
//   1. the caller's permission (kyc.view for an image, kyc.reveal for a reveal) -> refused and LOGGED as 'forbidden'
//   2. the configuration -> 'not_configured' is logged as 'config_error'
//   3. the call to the back end (with deadline) -> a code, never the back end's words
//   4. the adapter: masking happens HERE, so the browser only ever receives what it is allowed to show
//   5. the access log row is written; if it cannot be written NOTHING is returned (the log is never skipped)
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseValidations } from "./adapter";
import { writeAccessLog, type AccessLogInput, type KycAction } from "./audit";
import {
  KycError,
  checkHealth,
  fetchImage,
  fetchSignedImageUrl,
  fetchValidations,
  type FetchedImage,
} from "./client";
import { describeConfig, readKycConfig } from "./config";
import type { KycRuntime } from "./runtime";
import { FRIEND_ID_RE, VALIDATION_ID_RE, type KycErrorCode, type KycStatus, type KycValidationList } from "./types";

export interface KycCaller {
  accountId: string;
  userId: string;
  canView: boolean;
  canReveal: boolean;
  /** An admin or owner of the workspace. */
  isAdmin: boolean;
}

export type ServiceResult<T> = { ok: true; body: T } | { ok: false; code: KycErrorCode };

const ok = <T>(body: T): ServiceResult<T> => ({ ok: true, body });
const fail = <T = never>(code: KycErrorCode): ServiceResult<T> => ({ ok: false, code });

/** The HTTP status each code is answered with. */
export const STATUS_OF: Record<KycErrorCode, number> = {
  not_configured: 503,
  upstream_unreachable: 502,
  upstream_unauthorized: 502,
  not_found: 404,
  bad_response: 502,
  image_too_large: 502,
  image_type_unsupported: 502,
  image_host_blocked: 502,
  invalid_request: 400,
  rate_limited: 429,
  forbidden: 403,
  audit_failed: 503,
};

function logCode(code: string, hint?: string): void {
  // The code and, for a refused image host, the host name: never the friend id, the key, a URL or anything the back end said.
  console.warn(`[kyc] ${code}${hint ? ` (${hint.replace(/[^A-Za-z0-9._:-]/g, "")})` : ""}`);
}

/** Open to the screen: is it set up, UAT or not, which variables are missing (admins only), and what the caller may do. */
export async function kycStatus(caller: KycCaller, rt: KycRuntime, opts: { check?: boolean } = {}): Promise<KycStatus & { service?: "up" | "down" }> {
  const cfg = readKycConfig(rt.env);
  const d = describeConfig(cfg);
  const out: KycStatus & { service?: "up" | "down" } = {
    configured: d.configured,
    uat: d.uat,
    missing: caller.isAdmin ? d.missing : [],
    canView: caller.canView,
    canReveal: caller.canReveal,
    isAdmin: caller.isAdmin,
  };
  // The health check is for administrators who ask for it (the "Check connection" button): it sends no key and shows no data.
  if (opts.check && caller.isAdmin && cfg.ok) out.service = (await checkHealth(cfg.config, rt.transport)) ? "up" : "down";
  return out;
}

export interface LookupInput {
  /** "" = the latest checks of everybody (no filter). A reveal always has one. */
  friendId: string;
  limit: number;
  /** The page before this validation id (the previous page's `nextBeforeId`), or null for the first page. */
  beforeId?: string | null;
  /** A reload of a list already looked up: recorded as 'list' instead of 'lookup'. */
  reload: boolean;
  /** Show this validation's sensitive values in full. Needs kyc.reveal; recorded as 'reveal'. */
  revealValidationId: string | null;
}

export function validFriendId(v: string): boolean {
  return FRIEND_ID_RE.test(v);
}
export function validValidationId(v: string): boolean {
  return VALIDATION_ID_RE.test(v);
}

export async function lookupValidations(admin: SupabaseClient, caller: KycCaller, rt: KycRuntime, input: LookupInput): Promise<ServiceResult<KycValidationList>> {
  const revealing = input.revealValidationId !== null;
  const action: KycAction = revealing ? "reveal" : input.reload ? "list" : "lookup";
  const record = (outcome: AccessLogInput["outcome"], as: KycAction = action) =>
    writeAccessLog(admin, { accountId: caller.accountId, userId: caller.userId, action: as, friendId: input.friendId || null, validationId: input.revealValidationId, outcome });

  if (revealing && !caller.canReveal) {
    await record("forbidden");
    return fail("forbidden");
  }

  const cfg = readKycConfig(rt.env);
  if (!cfg.ok) {
    await record("error", "config_error");
    return fail("not_configured");
  }

  let body: unknown;
  try {
    body = await fetchValidations(cfg.config, rt.transport, input.friendId, input.limit, { beforeId: input.beforeId ?? null });
  } catch (err) {
    const code: KycErrorCode = err instanceof KycError ? err.code : "upstream_unreachable";
    if (code === "not_found") {
      // The back end does not know this friend id: an empty list, and a trace that someone looked.
      if (!(await record("not_found"))) return fail("audit_failed");
      return revealing ? fail("not_found") : ok({ friendId: input.friendId, items: [], nextBeforeId: null, revealedId: null, fallback: false });
    }
    logCode(code);
    await record("error", code === "upstream_unauthorized" ? "config_error" : action);
    return fail(code);
  }

  const parsed = parseValidations(body, { limit: input.limit, revealId: input.revealValidationId });
  if (!parsed) {
    logCode("bad_response");
    await record("error");
    return fail("bad_response");
  }
  if (revealing && !parsed.items.some((v) => v.id === input.revealValidationId)) {
    await record("not_found");
    return fail("not_found");
  }
  // The log first: when it cannot be written nothing is shown.
  if (!(await record(parsed.items.length === 0 ? "not_found" : "ok"))) return fail("audit_failed");
  return ok({ friendId: input.friendId, items: parsed.items, nextBeforeId: nextPage(parsed.items, input.limit), revealedId: revealing ? input.revealValidationId : null, fallback: parsed.fallback });
}

/** A full page means there may be older ones: the cursor is the smallest numeric id on it. A page that came back short is the last. */
export function nextPage(items: readonly { id: string }[], limit: number): string | null {
  if (items.length < limit) return null;
  let min: number | null = null;
  for (const v of items) {
    if (!/^[0-9]{1,12}$/.test(v.id)) continue;
    const n = Number(v.id);
    if (min === null || n < min) min = n;
  }
  return min === null ? null : String(min);
}

export interface ImageInput {
  validationId: string;
  /** For the log only; null when the screen did not send a valid one. */
  friendId: string | null;
}

export async function fetchValidationImage(admin: SupabaseClient, caller: KycCaller, rt: KycRuntime, input: ImageInput): Promise<ServiceResult<FetchedImage>> {
  const record = (outcome: AccessLogInput["outcome"], as: KycAction = "view_image") =>
    writeAccessLog(admin, { accountId: caller.accountId, userId: caller.userId, action: as, friendId: input.friendId, validationId: input.validationId, outcome });

  if (!caller.canView) {
    await record("forbidden");
    return fail("forbidden");
  }
  const cfg = readKycConfig(rt.env);
  if (!cfg.ok) {
    await record("error", "config_error");
    return fail("not_configured");
  }

  let image: FetchedImage;
  try {
    const url = await fetchSignedImageUrl(cfg.config, rt.transport, input.validationId);
    image = await fetchImage(rt.transport, url);
  } catch (err) {
    const code: KycErrorCode = err instanceof KycError ? err.code : "upstream_unreachable";
    const hint = err instanceof KycError ? err.hint : undefined;
    logCode(code, hint);
    if (code === "not_found") await record("not_found");
    else await record("error", code === "upstream_unauthorized" ? "config_error" : "view_image");
    return fail(code);
  }
  // The log first: when it cannot be written the bytes are dropped.
  if (!(await record("ok"))) return fail("audit_failed");
  return ok(image);
}
