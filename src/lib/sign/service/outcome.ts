// ============================================================
// Telling people how a document ended: the signed copy to everyone, an expiry to the sender and to
// whoever was still waiting. Never throws: a message that cannot be delivered is recorded and the
// document is already in its final state.
// ============================================================

import { isDelegate } from "../forward";
import { deliverCompleted, deliverOutcome } from "../notify";
import { isFormMode, type SignDocumentRow, type SignSignerRow } from "../types";
import { sendDocumentCopies } from "./copy-delivery";
import { docFacts } from "./send";
import { loadSenderAndWorkspace, loadSettings, logEvent, type SignCtx } from "./context";

async function workspace(ctx: SignCtx, doc: SignDocumentRow) {
  const [info, settings] = await Promise.all([loadSenderAndWorkspace(ctx, doc.created_by), loadSettings(ctx)]);
  return { info, w: { name: info.workspaceName, senderName: info.senderName, settings, timeZone: info.timeZone } };
}

/**
 * The signed copy to every signer and to the sender, attached when small enough, then to each person who receives a copy (migration 175: once, in this same step).
 * Not to a person who was handed only a part of someone's form: the copy holds the whole document.
 */
export async function notifyCompleted(ctx: SignCtx, doc: SignDocumentRow, signers: readonly SignSignerRow[], pdf: Uint8Array): Promise<void> {
  try {
    const { info, w } = await workspace(ctx, doc);
    const facts = docFacts(doc, ctx);
    const file = { bytes: pdf, filename: `${doc.reference ?? "document"}-${isFormMode(doc) ? "record" : "signed"}.pdf` };
    const people = signers.filter((s) => !isDelegate(s)).map((s) => ({ name: s.full_name, email: s.email, channel: s.channel, locale: s.locale ?? doc.locale, signerId: s.id as string | null }));
    if (info.senderEmail && !people.some((p) => p.email.toLowerCase() === info.senderEmail!.toLowerCase())) {
      people.push({ name: info.senderName, email: info.senderEmail, channel: "email", locale: doc.locale, signerId: null });
    }
    for (const p of people) {
      const d = await deliverCompleted(ctx.deps, facts, w, p, file);
      if (d.status !== "sent") await logEvent(ctx, doc.id, "delivery_failed", { actor: "system", signerId: p.signerId, detail: { kind: "completed", status: d.status, reason: d.detail ?? null } });
    }
    await sendDocumentCopies(ctx, doc, facts, w, file, new Set(people.map((p) => p.email.trim().toLowerCase())));
  } catch (err) {
    console.error("[sign] could not notify completion:", err instanceof Error ? err.message : err);
  }
}

/** An expired document: the sender and everyone who was waiting. */
export async function notifyExpired(ctx: SignCtx, doc: SignDocumentRow, signers: readonly SignSignerRow[]): Promise<void> {
  try {
    const { info, w } = await workspace(ctx, doc);
    const facts = docFacts(doc, ctx);
    if (info.senderEmail) await deliverOutcome(ctx.deps, facts, w, { name: info.senderName, email: info.senderEmail, channel: "email", locale: doc.locale }, { kind: "expired" });
    for (const s of signers.filter((x) => x.invited_at && x.status !== "signed" && x.status !== "declined")) {
      await deliverOutcome(ctx.deps, facts, w, { name: s.full_name, email: s.email, channel: s.channel, locale: s.locale ?? doc.locale }, { kind: "expired" });
    }
  } catch (err) {
    console.error("[sign] could not notify expiry:", err instanceof Error ? err.message : err);
  }
}
