// ============================================================
// Compliance requests: the emails about a case (Part B). Server only.
//
//   to the customer   received, more information needed, approved (off unless ticked), rejected, completed
//   to staff          a case reached the sign-off (holders of compliance.approve), a clock alert (holders of approve and review)
//
// Everything goes out through the shared workspace sender (lib/email/workspace-mail.ts: the workspace's connected mailbox first, then the platform
// sender, marker headers on every mailbox message so it never re-enters the Inbox). The rules this file keeps:
//
//   once only      a notice is CLAIMED first: a row in compliance_notices, UNIQUE per (case, kind, key). Whoever inserts it sends; a retry, a second click
//                  or a second server finds the row and does nothing. A manual "send again" may re-claim only a notice that FAILED (or one claimed so
//                  long ago that the server that held it died).
//   never blocks   a notice that could not be delivered is a recorded result ('failed' with a named reason, or 'skipped'), never an error for the
//                  transition or the form that wanted it sent. Every function here answers with a result and does not throw.
//   on the record  each attempt is a 'notice' event on the case: who asked for it, what kind, sent / failed / skipped, the language, the reason. A staff
//                  member's question or reason is the text they typed (as with notes); an address is never recorded anywhere but the case.
//   no secrets     the words are built by messages.ts from the reference, the name and the text staff wrote. The text a person writes for the customer is
//                  refused if it contains the case's bank account number or its phone number: a bank detail never goes out by email.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWorkspaceEmail, realWorkspaceMailDeps, type WorkspaceMailDeps } from "@/lib/email/workspace-mail";
import { reasonOfDetail } from "@/lib/email/send-reason";

import { complianceEnabled } from "../feature";
import { ComplianceError, complianceError } from "../errors";
import { clockAlertEmail, customerEmail, customerLocaleOf, signoffWaitingEmail, type CustomerNotice, type Rendered } from "../messages";
import { openSensitive } from "../secrets";
import type { CustomerLocale, NoticeKind } from "../types";
import { logEvent } from "./events";
import { holdersOf, loadRow, loadType } from "./read";
import type { ComplianceCaller, RequestRow } from "./rows";

export interface NoticeDeps {
  mail: WorkspaceMailDeps;
  now: () => Date;
}

export const realNoticeDeps: NoticeDeps = { mail: realWorkspaceMailDeps, now: () => new Date() };

export type NoticeResult = { status: "sent" | "failed" | "skipped" | "duplicate"; detail?: string; language?: CustomerLocale };

/** A claim held longer than this was left by a server that died: a manual "send again" may take it over. */
const STALE_CLAIM_MS = 10 * 60_000;
export const NOTICE_TEXT_MAX = 1000;
/** The clock alerts that are also emailed: this many days before the stop, and the stop itself (the sweep raises 10, 5 and 0). */
export const EMAIL_ALERT_FROM_DAYS = 5;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ---- the claim -----------------------------------------------------------------------------------------------------------

interface ClaimInput {
  accountId: string;
  requestId: string;
  kind: NoticeKind;
  key: string;
  audience: "customer" | "staff";
  language: CustomerLocale | null;
  claimedBy: string | null;
  /** A manual resend: take over a notice that failed (or whose server died). */
  retry?: boolean;
}

const isDuplicate = (e: { message?: string; code?: string } | null | undefined): boolean => !!e && (e.code === "23505" || /duplicate key|unique constraint/i.test(e.message ?? ""));

/** The id of the claim when this call holds it; null when another call already sent (or is sending) this notice. */
async function claim(admin: SupabaseClient, c: ClaimInput, now: Date): Promise<string | null> {
  const existing = await admin.from("compliance_notices").select("id, status, claimed_at").eq("request_id", c.requestId).eq("kind", c.kind).eq("key", c.key).maybeSingle();
  if (existing.error) return null;
  const row = existing.data as { id: string; status: string; claimed_at: string } | null;
  if (row) {
    if (!c.retry) return null;
    const stale = row.status === "claimed" && now.getTime() - Date.parse(row.claimed_at) > STALE_CLAIM_MS;
    if (row.status !== "failed" && !stale) return null;
    // take it over: only one caller can move it from failed to claimed
    const taken = await admin
      .from("compliance_notices")
      .update({ status: "claimed", detail: null, claimed_by: c.claimedBy, claimed_at: now.toISOString(), settled_at: null })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("id");
    const got = (taken.data ?? []) as { id: string }[];
    return !taken.error && got.length === 1 ? row.id : null;
  }
  const ins = await admin
    .from("compliance_notices")
    .insert({ account_id: c.accountId, request_id: c.requestId, kind: c.kind, key: c.key, audience: c.audience, status: "claimed", language: c.language, claimed_by: c.claimedBy, claimed_at: now.toISOString() })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    // a second caller inserted the same claim between our look and our insert: it sends, we do not
    if (!isDuplicate(ins.error)) console.error("[compliance] a notice could not be claimed");
    return null;
  }
  return (ins.data as { id: string }).id;
}

async function settle(admin: SupabaseClient, id: string, status: "sent" | "failed" | "skipped", detail: string | null, recipients: number, now: Date): Promise<void> {
  const { error } = await admin.from("compliance_notices").update({ status, detail: detail ? detail.slice(0, 300) : null, recipients, settled_at: now.toISOString() }).eq("id", id);
  if (error) console.error("[compliance] a notice result could not be recorded");
}

/**
 * A NAMED reason for the record ("mailbox_reconnect", "not_set_up", "address_rejected"), never what the mail service said (that can carry the address).
 * Anything that is not one of the named reasons is "send_failed".
 */
export function reasonOf(detail: string | undefined, status: string): string {
  if (status === "not_configured") return "not_set_up";
  return reasonOfDetail(detail) ?? "send_failed";
}

// ---- who the customer is, and what language they read --------------------------------------------------------------------

async function workspaceName(admin: SupabaseClient, accountId: string): Promise<string> {
  const { data } = await admin.from("accounts").select("name, brand_name").eq("id", accountId).maybeSingle();
  const a = data as { name?: string; brand_name?: string } | null;
  return a?.brand_name?.trim() || a?.name || "Halo";
}

/** The language of the customer's emails: the case's own, else the contact's, else English. */
export async function languageFor(admin: SupabaseClient, row: Pick<RequestRow, "customer_locale" | "contact_id" | "account_id">): Promise<CustomerLocale> {
  if (row.customer_locale) return row.customer_locale;
  if (row.contact_id) {
    const { data } = await admin.from("contacts").select("language").eq("id", row.contact_id).eq("account_id", row.account_id).maybeSingle();
    const l = customerLocaleOf((data as { language?: string | null } | null)?.language);
    if (l) return l;
  }
  return "en";
}

/** Digits of `text`, to spot a number that must not go out. */
const digitsOf = (s: string) => s.replace(/\D/g, "");

/** The text a person wrote for the customer, cleaned; refused when it carries the case's bank account number or phone number. */
export function checkCustomerText(text: string | null | undefined, secrets: { values: string[]; phone: string | null }): string {
  const t = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (t === "") throw complianceError("note_required");
  if (t.length > NOTICE_TEXT_MAX) throw new ComplianceError("validation_failed", "That text is too long.", 400, [{ field: "text", code: "too_long" }]);
  const d = digitsOf(t);
  for (const v of secrets.values) {
    const sd = digitsOf(v);
    if (sd.length >= 6 && d.includes(sd)) throw new ComplianceError("validation_failed", "Do not put bank details in a message to the customer.", 400, [{ field: "text", code: "contains_bank_detail" }]);
  }
  const pd = secrets.phone ? digitsOf(secrets.phone) : "";
  if (pd.length >= 8 && d.includes(pd)) throw new ComplianceError("validation_failed", "Do not put the phone number in a message to the customer.", 400, [{ field: "text", code: "contains_phone" }]);
  return t;
}

function secretsOf(row: RequestRow): { values: string[]; phone: string | null } {
  let values: string[] = [];
  try {
    values = Object.values(openSensitive(row.id, row.data_enc));
  } catch {
    values = [];
  }
  return { values, phone: row.customer_phone };
}

// ---- the customer's emails -------------------------------------------------------------------------------------------------

export interface CustomerNoticeInput {
  accountId: string;
  requestId: string;
  kind: CustomerNotice;
  /** More information: a nonce the screen made, so a double click or a retry is one email. Other kinds: "once". */
  key?: string;
  /** The staff's words (the question, or the reason a request cannot go ahead). */
  text?: string | null;
  /** The person who asked for it (null: the system, for the form's confirmation). */
  actor: string | null;
  /** Write the email in this language instead of the case's. */
  language?: CustomerLocale | null;
  retry?: boolean;
}

/**
 * Send one email to the customer of a case. Answers with the result; never throws (a text that carries a bank detail is the one refusal, raised before
 * anything is claimed, so the person can fix it).
 */
export async function sendCustomerNotice(admin: SupabaseClient, deps: NoticeDeps, input: CustomerNoticeInput): Promise<NoticeResult> {
  const now = deps.now();
  let row: RequestRow;
  try {
    row = await loadRow(admin, input.accountId, input.requestId);
  } catch {
    return { status: "failed", detail: "not_found" };
  }
  const needsText = input.kind === "more_info" || input.kind === "rejected";
  // a rejection sent again uses the words the Head of Compliance wrote when rejecting
  const stored = input.kind === "rejected" ? (((row.signoff ?? {}) as { customer_reason?: string }).customer_reason ?? null) : null;
  const text = needsText ? checkCustomerText(input.text ?? stored, secretsOf(row)) : null;
  const key = input.kind === "more_info" ? (input.key && NONCE_RE.test(input.key) ? input.key : null) : "once";
  if (!key) throw new ComplianceError("validation_failed", "Reload the page and try again.", 400, [{ field: "nonce", code: "invalid" }]);
  const language = input.language ?? (await languageFor(admin, row));

  const claimId = await claim(admin, { accountId: input.accountId, requestId: row.id, kind: input.kind, key, audience: "customer", language, claimedBy: input.actor, retry: input.retry }, now);
  if (!claimId) return { status: "duplicate" };

  const record = async (status: "sent" | "failed" | "skipped", detail: string | null): Promise<NoticeResult> => {
    await settle(admin, claimId, status, detail, status === "sent" ? 1 : 0, deps.now());
    await logEvent(admin, {
      accountId: input.accountId,
      requestId: row.id,
      actor: input.actor,
      kind: "notice",
      detail: { notice: input.kind, audience: "customer", status, language, ...(detail ? { reason: detail } : {}), ...(input.kind === "more_info" && text ? { text } : {}) },
    });
    return { status, ...(detail ? { detail } : {}), language };
  };

  const to = (row.customer_email ?? "").trim();
  if (!to) return record("skipped", "no_address");
  try {
    const workspace = await workspaceName(admin, input.accountId);
    const mail: Rendered = customerEmail(input.kind, { locale: language, workspace, name: row.customer_name, reference: row.reference, typeKey: row.type_key, targetDays: row.target_days, text });
    const result = await sendWorkspaceEmail(input.accountId, { to, subject: mail.subject, html: mail.html, text: mail.text }, deps.mail);
    if (result.status === "sent") return record("sent", null);
    return record("failed", reasonOf(result.detail, result.status));
  } catch (err) {
    console.error("[compliance] a customer notice failed:", err instanceof Error ? err.name : "error");
    return record("failed", "send_failed");
  }
}

/** What a customer notice would say, for the preview before it is sent. Writes nothing and sends nothing. */
export async function previewCustomerNotice(
  admin: SupabaseClient,
  caller: ComplianceCaller,
  requestId: string,
  input: { kind: CustomerNotice; text?: string | null; language?: CustomerLocale | null },
): Promise<{ subject: string; body: string; language: CustomerLocale; hasAddress: boolean }> {
  if (!(caller.viewer.canReview || caller.viewer.canApprove)) throw complianceError("forbidden");
  const row = await loadRow(admin, caller.accountId, requestId);
  const needsText = input.kind === "more_info" || input.kind === "rejected";
  const text = needsText ? checkCustomerText(input.text, secretsOf(row)) : null;
  const language = input.language ?? (await languageFor(admin, row));
  const workspace = await workspaceName(admin, caller.accountId);
  const mail = customerEmail(input.kind, { locale: language, workspace, name: row.customer_name, reference: row.reference, typeKey: row.type_key, targetDays: row.target_days, text });
  return { subject: mail.subject, body: mail.text, language, hasAddress: !!(row.customer_email ?? "").trim() };
}

// ---- staff emails ----------------------------------------------------------------------------------------------------------

interface Recipient {
  userId: string;
  email: string;
  locale: CustomerLocale;
}

/** The people (with an email address) who hold one of these capabilities in the workspace, in their own language. */
export async function staffRecipients(admin: SupabaseClient, accountId: string, caps: readonly string[], exclude: readonly (string | null | undefined)[] = []): Promise<Recipient[]> {
  const ids = new Set<string>();
  for (const cap of caps) for (const id of await holdersOf(admin, accountId, cap)) ids.add(id);
  for (const x of exclude) if (x) ids.delete(x);
  if (ids.size === 0) return [];
  const { data: profiles } = await admin.from("profiles").select("user_id, email, locale").eq("account_id", accountId).in("user_id", [...ids]);
  const { data: acct } = await admin.from("accounts").select("locale").eq("id", accountId).maybeSingle();
  const fallback = customerLocaleOf((acct as { locale?: string | null } | null)?.locale) ?? "en";
  const out: Recipient[] = [];
  for (const p of (profiles ?? []) as { user_id: string; email: string | null; locale: string | null }[]) {
    const email = (p.email ?? "").trim();
    if (email) out.push({ userId: p.user_id, email, locale: customerLocaleOf(p.locale) ?? fallback });
  }
  return out;
}

interface StaffNoticeInput {
  accountId: string;
  row: RequestRow;
  kind: "signoff_waiting" | "clock_alert";
  key: string;
  caps: readonly string[];
  exclude?: readonly (string | null | undefined)[];
  /** Builds the message in the recipient's language. */
  build: (r: Recipient, ctx: { workspace: string; typeLabel: (locale: CustomerLocale) => string }) => Rendered;
  actor: string | null;
}

async function sendStaffNotice(admin: SupabaseClient, deps: NoticeDeps, input: StaffNoticeInput): Promise<NoticeResult> {
  const now = deps.now();
  const claimId = await claim(admin, { accountId: input.accountId, requestId: input.row.id, kind: input.kind, key: input.key, audience: "staff", language: null, claimedBy: input.actor }, now);
  if (!claimId) return { status: "duplicate" };
  const finish = async (status: "sent" | "failed" | "skipped", detail: string | null, count: number): Promise<NoticeResult> => {
    await settle(admin, claimId, status, detail, count, deps.now());
    await logEvent(admin, { accountId: input.accountId, requestId: input.row.id, actor: input.actor, kind: "notice", detail: { notice: input.kind, audience: "staff", status, recipients: count, ...(detail ? { reason: detail } : {}) } });
    return { status, ...(detail ? { detail } : {}) };
  };
  try {
    const recipients = await staffRecipients(admin, input.accountId, input.caps, input.exclude);
    if (recipients.length === 0) return finish("skipped", "no_recipients", 0);
    const workspace = await workspaceName(admin, input.accountId);
    const type = await loadType(admin, input.accountId, input.row.type_key);
    const typeLabel = (locale: CustomerLocale) => (locale !== "en" ? type?.labelL10n[locale] : undefined) || type?.label || input.row.type_key;
    let sent = 0;
    let firstFailure: string | null = null;
    for (const r of recipients) {
      const mail = input.build(r, { workspace, typeLabel });
      const result = await sendWorkspaceEmail(input.accountId, { to: r.email, subject: mail.subject, html: mail.html, text: mail.text }, deps.mail);
      if (result.status === "sent") sent++;
      else firstFailure ??= reasonOf(result.detail, result.status);
    }
    return sent > 0 ? finish("sent", sent < recipients.length ? "some_failed" : null, sent) : finish("failed", firstFailure ?? "send_failed", 0);
  } catch (err) {
    console.error("[compliance] a staff notice failed:", err instanceof Error ? err.name : "error");
    return finish("failed", "send_failed", 0);
  }
}

/**
 * A case reached the Head of Compliance's sign-off. Puts a notification in front of each holder of compliance.approve and sends each an email (not the
 * person who recorded the identity check: they cannot sign this one off). Once per hand-over (the key is when the officer handed it over, so a case
 * sent back and handed over again is a new notice).
 */
export async function notifySignoffWaiting(admin: SupabaseClient, deps: NoticeDeps, accountId: string, requestId: string): Promise<NoticeResult> {
  let row: RequestRow;
  try {
    row = await loadRow(admin, accountId, requestId);
  } catch {
    return { status: "failed", detail: "not_found" };
  }
  if (row.status !== "awaiting_signoff" || !(await complianceEnabled(admin, accountId))) return { status: "skipped", detail: "not_waiting" };
  const review = (row.review ?? {}) as { at?: string; recommendation?: string };
  const key = `s-${(review.at ?? row.received_at).replace(/[^0-9A-Za-z]/g, "").slice(0, 40) || "x"}`;
  const identity = (row.identity_check ?? {}) as { verified_by?: string; recorded_by?: string };
  const exclude = [identity.verified_by, identity.recorded_by];
  const rec = review.recommendation === "approve" || review.recommendation === "reject" || review.recommendation === "more_info" ? review.recommendation : null;

  // the in-app notification first (the same once-only claim covers it: it is written only by the call that holds the claim)
  const result = await sendStaffNotice(admin, deps, {
    accountId,
    row,
    kind: "signoff_waiting",
    key,
    caps: ["compliance.approve"],
    exclude,
    actor: null,
    build: (r, ctx) => signoffWaitingEmail({ locale: r.locale, workspace: ctx.workspace, reference: row.reference, typeLabel: ctx.typeLabel(r.locale), recommendation: rec }),
  });
  if (result.status !== "duplicate") {
    try {
      const holders = (await holdersOf(admin, accountId, "compliance.approve")).filter((id) => !exclude.includes(id));
      if (holders.length > 0) {
        await admin.from("notifications").insert(
          holders.map((user_id) => ({ account_id: accountId, user_id, type: "compliance_signoff", title: `${row.reference}: waiting for your sign-off`, body: `Compliance request ${row.reference}`, compliance_request_id: row.id })),
        );
      }
    } catch {
      console.error("[compliance] the sign-off notifications could not be written");
    }
  }
  return result;
}

/**
 * The emails for the alerts the hourly sweep raised (migration 183: it claims each level once and writes a 'clock_alert' event). The event IS the
 * sweep's claim, so nothing is alerted again: this finds the alerts of the last three days and sends each one's email once (its own claim). Only the
 * 5-days and the breach alerts are emailed; the 10-day alert stays an in-app notification.
 */
export async function emailClockAlerts(admin: SupabaseClient, deps: NoticeDeps): Promise<{ looked: number; sent: number; skipped: number; failed: number }> {
  const since = new Date(deps.now().getTime() - 3 * 86_400_000).toISOString();
  const { data, error } = await admin.from("compliance_request_events").select("account_id, request_id, detail, at").eq("kind", "clock_alert").gte("at", since).order("at", { ascending: true }).limit(300);
  const out = { looked: 0, sent: 0, skipped: 0, failed: 0 };
  if (error) return out;
  const flag = new Map<string, boolean>();
  for (const e of (data ?? []) as { account_id: string; request_id: string; detail: { threshold?: number; days_left?: number } | null }[]) {
    out.looked++;
    if (!flag.has(e.account_id)) flag.set(e.account_id, await complianceEnabled(admin, e.account_id));
    if (!flag.get(e.account_id)) {
      out.skipped++;
      continue;
    }
    let row: RequestRow;
    try {
      row = await loadRow(admin, e.account_id, e.request_id);
    } catch {
      out.skipped++;
      continue;
    }
    // a case finished since the alert needs no email
    if (row.closed_at || row.completed_at) {
      out.skipped++;
      continue;
    }
    const threshold = typeof e.detail?.threshold === "number" ? e.detail.threshold : 0;
    const daysLeft = typeof e.detail?.days_left === "number" ? e.detail.days_left : 0;
    // the emails are for the 5-days-to-the-stop alert and the breach; the 10-day alert is the in-app notification only
    if (threshold > EMAIL_ALERT_FROM_DAYS) {
      out.skipped++;
      continue;
    }
    const r = await sendStaffNotice(admin, deps, {
      accountId: e.account_id,
      row,
      kind: "clock_alert",
      key: `t${threshold}`,
      caps: ["compliance.approve", "compliance.review"],
      actor: null,
      build: (rec, ctx) => clockAlertEmail({ locale: rec.locale, workspace: ctx.workspace, reference: row.reference, typeLabel: ctx.typeLabel(rec.locale), daysLeft: threshold === 0 ? 0 : daysLeft }),
    });
    if (r.status === "sent") out.sent++;
    else if (r.status === "failed") out.failed++;
    else out.skipped++;
  }
  return out;
}
