// ============================================================
// Envelopes (migration 171): the plain reads every envelope service starts with, scoped to the workspace. A document or a person is
// never found through an envelope id alone: the account is always part of the question.
// ============================================================

import type { SignDocumentRow, SignEnvelopeRow, SignSignerRow } from "../types";
import type { SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { assertCanSeeEnvelope } from "./privacy";

export async function loadEnvelope(ctx: SignCtx, envelopeId: string): Promise<SignEnvelopeRow> {
  const { data, error } = await ctx.admin.from("sign_envelopes").select("*").eq("id", envelopeId).eq("account_id", ctx.accountId).maybeSingle();
  if (error) raiseDatabaseError(error, "load envelope");
  if (!data) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
  // a private collection the caller may not see is "not found" too (service/privacy.ts)
  return assertCanSeeEnvelope(ctx, data as SignEnvelopeRow);
}

/** The documents of an envelope in their order (position 1 first). */
export async function loadEnvelopeDocuments(ctx: SignCtx, envelopeId: string): Promise<SignDocumentRow[]> {
  const { data, error } = await ctx.admin.from("sign_documents").select("*").eq("envelope_id", envelopeId).eq("account_id", ctx.accountId).order("envelope_position", { ascending: true });
  if (error) raiseDatabaseError(error, "load envelope documents");
  return (data ?? []) as SignDocumentRow[];
}

/** Every row of the signing list of an envelope (a person has one row on each document they are on). */
export async function loadEnvelopeSigners(ctx: SignCtx, documentIds: readonly string[]): Promise<SignSignerRow[]> {
  if (documentIds.length === 0) return [];
  const { data, error } = await ctx.admin.from("sign_signers").select("*").in("document_id", [...documentIds]).eq("account_id", ctx.accountId).order("order_no", { ascending: true }).order("created_at", { ascending: true });
  if (error) raiseDatabaseError(error, "load envelope signers");
  return (data ?? []) as SignSignerRow[];
}

/** The people of an envelope: their rows grouped by party (the anchor's id), each group in the order of the documents. */
export function groupByParty(rows: readonly SignSignerRow[], docs: readonly SignDocumentRow[]): Map<string, SignSignerRow[]> {
  const position = new Map(docs.map((d) => [d.id, d.envelope_position ?? 0]));
  const out = new Map<string, SignSignerRow[]>();
  for (const r of rows) {
    const key = r.party_id ?? r.id;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  for (const list of out.values()) list.sort((a, b) => (position.get(a.document_id) ?? 0) - (position.get(b.document_id) ?? 0));
  return out;
}

/** The anchor row of a person (the row whose id is the party id): the one that has the link. */
export const anchorOf = (rows: readonly SignSignerRow[]): SignSignerRow | undefined => rows.find((r) => r.id === r.party_id) ?? rows[0];
