// ============================================================
// KYC review: what each route does, apart from the HTTP. Server only.
//
// Every function here follows the same order, and the order is the security model:
//   1. the caller's permission (kyc.view for an image, kyc.reveal for a reveal, kyc.decide for a decision) -> refused and LOGGED as 'forbidden'
//   2. the configuration -> 'not_configured' is logged as 'config_error'
//   3. the call to the back end (with deadline) -> a code, never the back end's words
//   4. the adapter: masking happens HERE, so the browser only ever receives what it is allowed to show
//   5. the access log row is written; if it cannot be written NOTHING is returned (the log is never skipped)
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildValidation, extractItems, parseValidations, statusTone } from "./adapter";
import { writeAccessLog, type AccessLogInput, type KycAction } from "./audit";
import {
  KycError,
  checkHealth,
  fetchImage,
  fetchSignedImageUrl,
  fetchValidations,
  postReview,
  type FetchedImage,
} from "./client";
import { describeConfig, readKycConfig } from "./config";
import type { KycRuntime } from "./runtime";
import { reviewKind } from "./review";
import { DECISION_NOTE_MAX, FRIEND_ID_RE, VALIDATION_ID_RE, type KycDecision, type KycDecisionResult, type KycErrorCode, type KycStatus, type KycValidationList } from "./types";

export interface KycCaller {
  accountId: string;
  userId: string;
  canView: boolean;
  canReveal: boolean;
  canDecide: boolean;
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
  already_decided: 409,
  amend_refused: 409,
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
    canDecide: caller.canDecide,
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
  /** The one filter the back end applies besides the friend id: `nric`, `passport` or `selfie`. null leaves it out. */
  docType?: string | null;
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
    body = await fetchValidations(cfg.config, rt.transport, input.friendId, input.limit, { beforeId: input.beforeId ?? null, docType: input.docType ?? null });
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

export interface DecisionInput {
  validationId: string;
  /** The child's friend id: needed to look the validation up again before deciding (the back end has no read-one call). */
  friendId: string;
  decision: KycDecision;
  /** Already cleaned by normaliseNote and within DECISION_NOTE_MAX; required by the route for a rejection and for an amendment. */
  note: string;
  /**
   * Amend a check that is already REJECTED and approve it. Only rejected -> approved: the check must carry a rejection, the decision must be approve and a
   * note (the reason it changed) is required. Without it a check that already carries a review is never decided again.
   */
  amend?: boolean;
}

/** A note as a single clean line: no control or bidi characters, runs of white space made one, trimmed. */
export function normaliseNote(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Approve or reject one ID check. See the order in the header of this file; the extra rules for a write are in the numbered comments. */
export async function decideValidation(admin: SupabaseClient, caller: KycCaller, rt: KycRuntime, input: DecisionInput): Promise<ServiceResult<KycDecisionResult>> {
  // An amendment is logged as an 'amend', never as a 'decision', so an audit can tell it from a first decision without reading the order of two rows.
  const act: KycAction = input.amend ? "amend" : "decision";
  const record = (outcome: AccessLogInput["outcome"], as: KycAction = act) =>
    writeAccessLog(admin, {
      accountId: caller.accountId,
      userId: caller.userId,
      action: as,
      friendId: input.friendId,
      validationId: input.validationId,
      outcome,
      decision: as === "decision" || as === "amend" ? input.decision : null,
    });

  if (!caller.canDecide) {
    await record("forbidden");
    return fail("forbidden");
  }
  if (input.note.length > DECISION_NOTE_MAX || (input.decision === "reject" && input.note === "")) return fail("invalid_request");
  // An amendment is rejected -> approved and says why; anything else is not an amendment.
  if (input.amend && (input.decision !== "approve" || input.note === "")) return fail("invalid_request");
  const cfg = readKycConfig(rt.env);
  if (!cfg.ok) {
    await record("error", "config_error");
    return fail("not_configured");
  }

  // 1. Is it still undecided? The back end has no "read one" call, so the child's list is read again and the record found in it. Somebody else may
  //    have decided since this person opened it (and a rejection e-mails the parent), so a record that already carries a review is not decided twice.
  //    A record not found in the first 100 is let through: the back end answers 409 for one it refuses.
  try {
    const records = extractItems(await fetchValidations(cfg.config, rt.transport, input.friendId, 100));
    const found = records?.map((r) => buildValidation(r)).find((v) => v.id === input.validationId);
    if (input.amend) {
      // The check must be seen, and must carry a REJECTION: that is the only thing that is amended. (Unlike a first decision, a check that cannot be
      // found is not let through: there would be no way to know what is being changed.)
      if (!found) {
        await record("not_found");
        return fail("not_found");
      }
      if (!found.review) {
        await record("error");
        return fail("invalid_request");
      }
      if (reviewKind(found.review.raw) !== "rejected") {
        await record("error");
        return fail("already_decided");
      }
    } else if (found?.review) {
      await record("error");
      return fail("already_decided");
    }
  } catch (err) {
    const code: KycErrorCode = err instanceof KycError ? err.code : "upstream_unreachable";
    if (code === "not_found") {
      await record("not_found");
      return fail("not_found");
    }
    logCode(code);
    await record("error", code === "upstream_unauthorized" ? "config_error" : act);
    return fail(code);
  }

  // 2. The log first: the attempt is written BEFORE the back end is called, and when it cannot be written nothing is sent.
  if (!(await record("attempt"))) return fail("audit_failed");

  // 3. The one call that changes something. Never retried.
  let reply: Awaited<ReturnType<typeof postReview>>;
  try {
    reply = await postReview(cfg.config, rt.transport, input.validationId, input.decision, input.note, { amend: input.amend === true });
  } catch (err) {
    const code: KycErrorCode = err instanceof KycError ? err.code : "upstream_unreachable";
    logCode(code);
    if (code === "not_found") await record("not_found");
    else await record("error", code === "upstream_unauthorized" ? "config_error" : act);
    return fail(code);
  }

  // 4. The decision is taken; a failure to write the result row is logged but does not hide it (the attempt row is already there).
  await record("ok");
  const reviewStatus = reply.reviewStatus ?? (input.decision === "approve" ? "APPROVED" : "REJECTED");
  return ok({
    decision: input.decision,
    reviewStatus,
    reviewTone: statusTone(reviewStatus),
    reviewedAt: reply.reviewedAt ?? new Date().toISOString(),
    note: input.note === "" ? null : input.note,
    partial: reply.partial,
    emailSent: input.decision === "reject" ? reply.emailSent : null,
    amended: input.amend === true,
  });
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
