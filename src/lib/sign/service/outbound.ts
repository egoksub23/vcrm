// ============================================================
// Telling the rest of the workspace what happened to a document: the one place that turns a Doc Sign state
// change into (a) the `sign_document_event` automation trigger and (b) the outbound webhook `sign.<event>`.
// The six hook points (sendDocument, markViewed, sealDocument, declineSigning, runExpiry, voidDocument) each
// make one call, after the change is committed.
//
// It never throws and never holds the change up: the work runs after the response when there is a request
// to run after (Next's `after`), and inline otherwise (the jobs, the tests). A failure here is logged and
// goes no further, so a broken endpoint or a broken automation can never undo a signature.
//
// What goes out is deliberately small: the document's id, reference, title, status, template, category,
// contact id, dates, and each signer's name, role, status and signing time. Never an email address, a phone
// number, a link token or a file address. For a completed document: the fingerprint of the signed file and the
// public page that proves it (the same address as the certificate's QR code).
//
// Loop guard: an automation started by one of these events can itself send a document, which is another
// event. The depth travels in `ctx.chainDepth` / `vars._sign_chain_depth` (the tag chain's pattern) and the
// trigger stops being dispatched at MAX_SIGN_CHAIN_DEPTH links; the webhook is not affected.
// ============================================================

import { after } from "next/server";

import { MAX_SIGN_CHAIN_DEPTH, SIGN_CHAIN_VAR, type SignEventContext } from "@/lib/automations/sign-event";
import { dispatchWebhookEvent } from "@/lib/webhooks/deliver";
import type { WebhookEvent } from "@/lib/webhooks/events";
import type { SignEventName } from "@/types";

import { signEnabled } from "../feature";
import { verifyLink } from "../notify";
import { isFormMode, type SignDocumentRow, type SignMode, type SignRole, type SignSignerRow } from "../types";
import { loadSigners, type SignCtx } from "./context";

export type SignEvent = SignEventName;

export interface SignEventExtra {
  /** The person the event is about (who opened it, who declined). Their name and role go out, nothing else. */
  signerId?: string | null;
}

/** The payload of `sign.<event>`: `data` of the webhook, and the source of what the automation context carries. */
export interface SignEventData {
  document_id: string;
  reference: string | null;
  title: string;
  status: string;
  /** `sign` (an agreement to sign) or `form` (a form without a signature: its people "submit", and `signers[].signed_at` is when they did). */
  mode: SignMode;
  template_id: string | null;
  template_name: string | null;
  category_id: string | null;
  category: string | null;
  contact_id: string | null;
  /** Migration 171: the envelope this document is part of (read only; null for a document on its own). Each document of an envelope sends its own events. */
  envelope_id: string | null;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  signers: { name: string; role: string; role_key: string; status: string; signed_at: string | null }[];
  /** viewed and declined: who it was. */
  signer?: { name: string; role: string };
  /** completed only */
  final_sha256?: string;
  /** completed only (migration 178): the SHA-256 of the certificate when it is a file of its own, which the API serves at GET /api/v1/sign/documents/{id}/certificate. Absent when the certificate is inside the signed PDF (a document sealed earlier). */
  certificate_sha256?: string;
  verify_url?: string;
}

interface Extras {
  templateId: string | null;
  templateName: string | null;
  categoryName: string | null;
}

/** Build the payload. Pure, so a test can assert on exactly what leaves the building. */
export function buildSignEventData(doc: SignDocumentRow, signers: readonly SignSignerRow[], event: SignEvent, origin: string, extras: Extras, who?: SignSignerRow | null): SignEventData {
  const roles: readonly SignRole[] = doc.roles_snapshot ?? [];
  const label = (key: string) => roles.find((r) => r.key === key)?.label ?? key;
  const data: SignEventData = {
    document_id: doc.id,
    reference: doc.reference,
    title: doc.title,
    status: doc.status,
    mode: isFormMode(doc) ? "form" : "sign",
    template_id: extras.templateId,
    template_name: extras.templateName,
    category_id: doc.category_id,
    category: extras.categoryName,
    contact_id: doc.contact_id,
    envelope_id: doc.envelope_id ?? null,
    created_at: doc.created_at,
    sent_at: doc.sent_at,
    completed_at: doc.completed_at,
    signers: signers.map((s) => ({ name: s.full_name, role: label(s.role_key), role_key: s.role_key, status: s.status, signed_at: s.signed_at })),
  };
  if ((event === "viewed" || event === "declined") && who) data.signer = { name: who.full_name, role: label(who.role_key) };
  if (event === "completed") {
    if (doc.final_sha256) data.final_sha256 = doc.final_sha256;
    if (doc.certificate_sha256) data.certificate_sha256 = doc.certificate_sha256;
    data.verify_url = verifyLink(origin, doc.id);
  }
  return data;
}

/** What `{{ sign.* }}` and the trigger's filters read. */
export function toAutomationContext(data: SignEventData, event: SignEvent): SignEventContext {
  return {
    document_id: data.document_id,
    reference: data.reference ?? "",
    title: data.title,
    status: data.status,
    event,
    template: data.template_name ?? "",
    template_id: data.template_id ?? "",
    category_id: data.category_id ?? "",
    final_sha256: data.final_sha256 ?? "",
    certificate_sha256: data.certificate_sha256 ?? "",
    verify_url: data.verify_url ?? "",
  };
}

async function extrasFor(ctx: SignCtx, doc: SignDocumentRow): Promise<Extras> {
  const out: Extras = { templateId: null, templateName: null, categoryName: null };
  if (doc.template_version_id) {
    const v = await ctx.admin.from("sign_template_versions").select("template_id").eq("id", doc.template_version_id).eq("account_id", ctx.accountId).maybeSingle();
    const templateId = (v.data as { template_id?: string } | null)?.template_id ?? null;
    if (templateId) {
      const t = await ctx.admin.from("sign_templates").select("id, name").eq("id", templateId).eq("account_id", ctx.accountId).maybeSingle();
      const row = t.data as { id: string; name: string } | null;
      out.templateId = row?.id ?? templateId;
      out.templateName = row?.name ?? null;
    }
  }
  if (doc.category_id) {
    const c = await ctx.admin.from("sign_categories").select("name").eq("id", doc.category_id).eq("account_id", ctx.accountId).maybeSingle();
    out.categoryName = (c.data as { name?: string } | null)?.name ?? null;
  }
  return out;
}

async function emit(ctx: SignCtx, given: SignDocumentRow, event: SignEvent, extra: SignEventExtra): Promise<void> {
  try {
    // Doc Sign off for the workspace: nothing is emitted (the flag also reads "suspended" as off).
    if (!(await signEnabled(ctx.admin, ctx.accountId))) return;

    // Read the document again: the caller's copy is from before the change.
    const fresh = await ctx.admin.from("sign_documents").select("*").eq("id", given.id).eq("account_id", ctx.accountId).maybeSingle();
    const doc = (fresh.data as SignDocumentRow | null) ?? given;
    // a test document (F-10) is a rehearsal: nothing is sent to webhooks or automations about it
    if (doc.test) return;
    const signers = await loadSigners(ctx, doc.id);
    const data = buildSignEventData(doc, signers, event, ctx.origin, await extrasFor(ctx, doc), extra.signerId ? signers.find((s) => s.id === extra.signerId) : null);

    const depth = ctx.chainDepth ?? 0;
    const runAutomations = async () => {
      if (depth >= MAX_SIGN_CHAIN_DEPTH) {
        console.warn("[sign] automation chain depth limit reached, trigger not dispatched", { documentId: doc.id, event, depth });
        return;
      }
      // Most workspaces have no Doc Sign automation: one small read spares them loading and running the engine.
      const found = await ctx.admin.from("automations").select("id").eq("account_id", ctx.accountId).eq("trigger_type", "sign_document_event").eq("is_active", true).limit(1);
      if (!Array.isArray(found.data) || found.data.length === 0) return;
      // Dynamic import: the automation engine imports the Doc Sign services for its send step.
      const { runAutomationsForTrigger } = await import("@/lib/automations/engine");
      await runAutomationsForTrigger({
        accountId: ctx.accountId,
        triggerType: "sign_document_event",
        contactId: doc.contact_id,
        context: { sign: toAutomationContext(data, event), vars: { [SIGN_CHAIN_VAR]: depth + 1 } },
      });
    };
    const sendWebhook = () => dispatchWebhookEvent(ctx.admin, ctx.accountId, `sign.${event}` as WebhookEvent, data);

    // Each channel on its own: one failing never stops the other.
    const results = await Promise.allSettled([runAutomations(), sendWebhook()]);
    for (const r of results) if (r.status === "rejected") console.error("[sign] event dispatch failed:", event, r.reason instanceof Error ? r.reason.message : r.reason);
  } catch (err) {
    console.error("[sign] could not emit event", event, err instanceof Error ? err.message : err);
  }
}

/**
 * Announce that a document was sent, viewed, completed, declined, expired or voided. Call it after the change
 * is committed. Never throws; returns once the work is handed over (after the response) or done.
 */
export async function emitSignEvent(ctx: SignCtx, doc: SignDocumentRow, event: SignEvent, extra: SignEventExtra = {}): Promise<void> {
  try {
    const job = () => emit(ctx, doc, event, extra);
    try {
      after(job);
    } catch {
      // not inside a request (a job, a test): do it here
      await job();
    }
  } catch (err) {
    console.error("[sign] could not hand over event", event, err instanceof Error ? err.message : err);
  }
}
