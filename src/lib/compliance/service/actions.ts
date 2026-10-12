// ============================================================
// Compliance requests: the steps of a case. Server only. Each one checks the caller's permission, checks the case is in this workspace, then calls
// the database function that is the real rule (compliance_transition, compliance_tick_step, compliance_set_standing, compliance_clock): the function
// re-checks the permission against the named person, applies the maker-checker rule and the transition table under a row lock, and writes the event.
// What is here only answers early, with a clear code, and keeps the browser away from the database's words.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { ComplianceError, complianceError, fromDatabase } from "../errors";
import { openSensitive, revealedFields } from "../secrets";
import { canMove, makerCheckerAllows, viewerMayMove } from "../transitions";
import { IDENTITY_METHODS, IDENTITY_OUTCOMES, RECOMMENDATIONS, type IdentityMethod, type IdentityOutcome, type Recommendation, type RequestStatus } from "../types";
import { identityOf } from "./rows";
import { logEvent } from "./events";
import { loadRow, loadType } from "./read";
import type { ComplianceCaller } from "./rows";

export interface TransitionInput {
  to: RequestStatus;
  /** The step's note: the identity check's notes, the review notes, the reason to reject, the reason to send back, the closing note. */
  note?: string | null;
  /** Recording the identity check (the move to officer_review from received or identity_check). */
  identity?: { method: string; methodOther?: string | null; outcome: string } | null;
  /** Handing over for sign-off (the move to awaiting_signoff). */
  recommendation?: string | null;
  /** Approving a closure whose dues are outstanding: why the Head approves anyway. */
  overrideReason?: string | null;
}

const NOTE_MAX = 2000;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export async function transitionRequest(admin: SupabaseClient, caller: ComplianceCaller, id: string, input: TransitionInput): Promise<{ from: RequestStatus; to: RequestStatus }> {
  const row = await loadRow(admin, caller.accountId, id);
  const to = input.to;
  if (!canMove(row.status, to)) throw complianceError("invalid_transition");
  if (!viewerMayMove(caller.viewer, row.status, to)) throw complianceError("forbidden");

  const note = (input.note ?? "").trim();
  if (note.length > NOTE_MAX) throw new ComplianceError("validation_failed", "That note is too long.", 400, [{ field: "note", code: "too_long" }]);

  const payload: Record<string, unknown> = {};
  if (to === "officer_review" && (row.status === "received" || row.status === "identity_check")) {
    const type = await loadType(admin, caller.accountId, row.type_key);
    if (type?.requiresIdentityCheck) {
      const idn = input.identity;
      if (!idn || !oneOf<IdentityMethod>(IDENTITY_METHODS, idn.method) || !oneOf<IdentityOutcome>(IDENTITY_OUTCOMES, idn.outcome)) throw complianceError("identity_incomplete");
      if (idn.method === "other" && !(idn.methodOther ?? "").trim()) throw complianceError("identity_incomplete");
      if (idn.outcome === "fail" && note === "") throw complianceError("note_required");
      payload.method = idn.method;
      payload.method_other = idn.method === "other" ? (idn.methodOther ?? "").trim().slice(0, 200) : null;
      payload.outcome = idn.outcome;
    }
  } else if (to === "awaiting_signoff") {
    if (!oneOf<Recommendation>(RECOMMENDATIONS, input.recommendation)) throw complianceError("recommendation_required");
    payload.recommendation = input.recommendation;
  } else if (to === "approved" || to === "rejected") {
    // the early answer for the maker-checker rule; the database enforces it under the row lock
    if (!makerCheckerAllows(identityOf(row.identity_check), caller.userId)) throw complianceError("maker_checker");
    if (to === "approved" && (input.overrideReason ?? "").trim() !== "") payload.override_reason = (input.overrideReason ?? "").trim().slice(0, NOTE_MAX);
  }
  if ((to === "rejected" || (row.status === "awaiting_signoff" && to === "officer_review")) && note === "") throw complianceError("note_required");

  const { error } = await admin.rpc("compliance_transition", { p_request: row.id, p_to: to, p_actor: caller.userId, p_note: note === "" ? null : note, p_payload: payload });
  if (error) throw fromDatabase(error);
  return { from: row.status, to };
}

export async function tickStep(admin: SupabaseClient, caller: ComplianceCaller, id: string, stepKey: string, done: boolean, note?: string | null): Promise<void> {
  if (!caller.viewer.canExecute) throw complianceError("forbidden");
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(stepKey)) throw complianceError("invalid_request");
  const text = (note ?? "").trim();
  if (text.length > NOTE_MAX) throw new ComplianceError("validation_failed", "That note is too long.", 400, [{ field: "note", code: "too_long" }]);
  const row = await loadRow(admin, caller.accountId, id);
  const { error } = await admin.rpc("compliance_tick_step", { p_request: row.id, p_step: stepKey, p_done: done, p_actor: caller.userId, p_note: text === "" ? null : text });
  if (error) throw fromDatabase(error);
}

export async function setStanding(admin: SupabaseClient, caller: ComplianceCaller, id: string, duesOutstanding: boolean, notes?: string | null): Promise<void> {
  if (!(caller.viewer.canReview || caller.viewer.canApprove)) throw complianceError("forbidden");
  if (typeof duesOutstanding !== "boolean") throw complianceError("invalid_request");
  const text = (notes ?? "").trim();
  if (text.length > NOTE_MAX) throw new ComplianceError("validation_failed", "That note is too long.", 400, [{ field: "notes", code: "too_long" }]);
  const row = await loadRow(admin, caller.accountId, id);
  const { error } = await admin.rpc("compliance_set_standing", { p_request: row.id, p_actor: caller.userId, p_dues: duesOutstanding, p_notes: text === "" ? null : text });
  if (error) throw fromDatabase(error);
}

export async function clockAction(admin: SupabaseClient, caller: ComplianceCaller, id: string, action: "pause" | "resume", note: string): Promise<void> {
  if (!caller.viewer.canApprove) throw complianceError("forbidden");
  if (action !== "pause" && action !== "resume") throw complianceError("invalid_request");
  const text = (note ?? "").trim();
  if (text === "") throw complianceError("note_required");
  if (text.length > NOTE_MAX) throw new ComplianceError("validation_failed", "That note is too long.", 400, [{ field: "note", code: "too_long" }]);
  const row = await loadRow(admin, caller.accountId, id);
  const { error } = await admin.rpc("compliance_clock", { p_request: row.id, p_actor: caller.userId, p_action: action, p_note: text });
  if (error) throw fromDatabase(error);
}

/**
 * Reveal the sensitive answers of ONE case. Needs compliance.reveal. The 'reveal' event is written FIRST: when the trail cannot be written nothing is
 * returned. The route rate limits per person. The browser hides the values again after two minutes.
 */
export async function revealSensitive(admin: SupabaseClient, caller: ComplianceCaller, id: string): Promise<{ fields: { key: string; label: { en: string; ms?: string; zh?: string; ko?: string }; value: string }[]; expiresInSeconds: number }> {
  if (!caller.viewer.canReveal) {
    // a refused attempt is part of the trail too
    const row = await loadRow(admin, caller.accountId, id).catch(() => null);
    if (row) await logEvent(admin, { accountId: caller.accountId, requestId: row.id, actor: caller.userId, kind: "reveal", detail: { allowed: false } });
    throw complianceError("forbidden");
  }
  const row = await loadRow(admin, caller.accountId, id);
  const type = await loadType(admin, caller.accountId, row.type_key);
  const values = openSensitive(row.id, row.data_enc);
  const fields = revealedFields(type?.fields ?? [], values);
  if (!(await logEvent(admin, { accountId: caller.accountId, requestId: row.id, actor: caller.userId, kind: "reveal", detail: { allowed: true, fields: fields.map((f) => f.key) } }))) throw complianceError("audit_failed");
  return { fields, expiresInSeconds: 120 };
}

