// ============================================================
// The public verify page: what anyone holding a signed document's certificate may learn from the QR code
// on it. The address carries the document's id (an unguessable v4 UUID), and nothing else guards it, so
// this is deliberately the least that lets a person trust the file in their hand:
//
//   - that the document was completed and when, in whose workspace, with what title and reference;
//   - who signed and when (names and times only: no email, phone, network address or device, which the
//     certificate page itself does not put in front of a stranger either);
//   - the file's SHA-256, so the page can compare it with the copy the person holds, in their browser;
//   - whether the document's audit chain still recomputes (sign_verify_chain, migration 157).
//
// A document that is not completed, whose workspace has Doc Sign off or is suspended, or that does not
// exist, all give the same answer: null. A page for such an address says nothing about which it was.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { signEnabled } from "../feature";
import { realDeps } from "../notify";
import { isFormMode, type SignDocumentRow, type SignMode, type SignSignerRow } from "../types";
import { loadSenderAndWorkspace, loadSigners, type SignCtx } from "./context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isDocumentId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** The record of events: recomputed and intact, recomputed and broken, or not checked (the check failed to run). */
export type ChainState = "intact" | "broken" | "unknown";

export interface VerifyView {
  title: string;
  reference: string | null;
  pageCount: number | null;
  completedAt: string;
  workspace: { name: string; logoUrl: string | null };
  /** People who signed (or, for a form without a signature, submitted), in the order they did. */
  signers: { name: string; signedAt: string | null }[];
  /** Migration 169: `form` for a form without a signature, whose sealed file is the submission record. Absent is an agreement. */
  mode?: SignMode;
  /** Migration 171: the document was signed as one of an envelope. Only how many documents it has: never a sibling's title or any other detail. */
  envelope?: { documents: number };
  /** SHA-256 (hex) of the sealed PDF. */
  sha256: string;
  chain: ChainState;
  /** How many events the chain holds (shown next to its state). */
  events: number | null;
}

type DocRow = Pick<SignDocumentRow, "id" | "account_id" | "title" | "reference" | "status" | "completed_at" | "page_count" | "final_sha256"> & { mode?: SignMode | null; envelope_id?: string | null };

function chainOf(data: unknown): { state: ChainState; events: number | null } {
  if (typeof data !== "object" || data === null) return { state: "unknown", events: null };
  const r = data as { ok?: unknown; events?: unknown };
  const events = typeof r.events === "number" ? r.events : null;
  if (r.ok === true) return { state: "intact", events };
  if (r.ok === false) return { state: "broken", events };
  return { state: "unknown", events };
}

export function signedPeople(signers: readonly SignSignerRow[], mode?: SignMode | null): VerifyView["signers"] {
  // in a form without a signature nobody is a signer: everyone who submitted is listed
  return signers
    .filter((s) => (isFormMode(mode) || s.kind === "signer") && s.status === "signed")
    .map((s) => ({ name: s.full_name, signedAt: s.signed_at }))
    .sort((a, b) => (a.signedAt ?? "").localeCompare(b.signedAt ?? ""));
}

export async function loadVerification(admin: SupabaseClient, id: unknown, now: () => Date = () => new Date()): Promise<VerifyView | null> {
  if (!isDocumentId(id)) return null;
  const found = await admin.from("sign_documents").select("id, account_id, title, reference, status, mode, envelope_id, completed_at, page_count, final_sha256").eq("id", id).maybeSingle();
  if (found.error || !found.data) return null;
  const doc = found.data as DocRow;
  if (doc.status !== "completed" || !doc.completed_at || !doc.final_sha256) return null;
  if (!(await signEnabled(admin, doc.account_id))) return null;

  const ctx: SignCtx = { admin, accountId: doc.account_id, userId: null, origin: "", deps: realDeps, now };
  const [info, signers, chain] = await Promise.all([
    loadSenderAndWorkspace(ctx, null),
    loadSigners(ctx, doc.id),
    admin.rpc("sign_verify_chain", { p_document: doc.id }),
  ]);
  const checked = chain.error ? { state: "unknown" as ChainState, events: null } : chainOf(chain.data);
  // part of an envelope: say how many documents it holds (a count only, within the document's own workspace)
  let envelopeDocuments: number | null = null;
  if (doc.envelope_id) {
    const n = await admin.from("sign_documents").select("id", { count: "exact", head: true }).eq("envelope_id", doc.envelope_id).eq("account_id", doc.account_id);
    if (!n.error && typeof n.count === "number" && n.count > 1) envelopeDocuments = n.count;
  }
  return {
    title: doc.title,
    reference: doc.reference,
    pageCount: doc.page_count,
    completedAt: doc.completed_at,
    workspace: { name: info.workspaceName, logoUrl: info.logoUrl },
    signers: signedPeople(signers, doc.mode),
    ...(isFormMode(doc.mode) ? { mode: "form" as const } : {}),
    ...(envelopeDocuments ? { envelope: { documents: envelopeDocuments } } : {}),
    sha256: doc.final_sha256,
    chain: checked.state,
    events: checked.events,
  };
}
