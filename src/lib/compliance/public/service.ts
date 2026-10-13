// ============================================================
// Compliance requests, the public parent forms, the server side (Part B). What happens when a stranger opens /c/<slug>: they have no login, so this is
// where the guards are. SERVER ONLY.
//
//   1. The form must exist, be switched on, its type must be active and carry the fields the form needs, and the workspace must have the `compliance`
//      flag on. Anything else is one plain "not available", never saying which.
//   2. They prove they control an email address: a six-digit code, emailed through the workspace's own sender, valid 15 minutes, five tries, three
//      codes an hour per address (limits shared across servers; the address and the caller are kept only as keyed hashes). A correct code gives a
//      session (an HttpOnly cookie, 60 minutes) that carries a hash of that address.
//   3. They fill the form. A submission needs: the page's signed form token (genuine, for THIS form, 8 seconds to 2 hours old), the session, the same
//      address typed again, the hidden field empty, the optional Turnstile check (done when the code is asked for, where the email cost is), and details
//      that pass parsePublicSubmission, plus the files: PDF, JPEG or PNG by their first bytes, 10 MB each, an authorization letter when the parent says the
//      bank account is NOT their own (a letter sent with a "Yes" is dropped, never stored).
//   4. One OPEN request per type per verified address: a repeat is answered exactly like a first request (the same confirmation, with the reference of
//      the request the person already has, which they have proved they own the address for) and creates nothing. Two posts at the same moment are
//      held apart by a unique index in the database.
//   5. The case is made by createComplianceRequest (source "form", channel "web_form", request date now, identity check NOT done). It is linked to a
//      contact only when the verified email or the phone matches exactly ONE contact of THIS workspace; no contact is ever created here.
//   6. The customer is emailed the confirmation (once-only claim; a failure to send is recorded and never an error for the person).
//
// What is stored: the answers, the sensitive ones (the three bank answers) encrypted. What is shown back: the reference and the address the person typed,
// masked. Nothing stored is ever displayed back, and no answer says whether an email, a phone number or a case exists.
// ============================================================

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWorkspaceEmail } from "@/lib/email/workspace-mail";
import { detectFileKind } from "@/lib/net/file-kind";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { isTooFast, issueFormToken, readFormToken } from "@/lib/sign/registration/token";
import { normalizeSlug } from "@/lib/sign/registration/slug";

import { complianceEnabled } from "../feature";
import { ComplianceError } from "../errors";
import { codeEmail } from "../messages";
import { sendCustomerNotice, type NoticeDeps } from "../service/notices";
import { COMPLIANCE_BUCKET, putEvidence, recordEvidence, type StoredEvidence } from "../service/files";
import { loadType } from "../service/read";
import { createComplianceRequest } from "../service/write";
import type { RequestTypeRow, CustomerLocale } from "../types";
import { LOCALES } from "../types";
import { cleanEmail, maskEmail } from "./amount";
import { banksFor } from "./banks";
import {
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  MIN_FILL_AFTER_VERIFY_MS,
  checkCode,
  createSession,
  generateCode,
  hashCode,
  hashEmail,
  hashIp,
  publicFormsConfigured,
  readSession,
  sessionCookieName,
  sessionHolds,
} from "./session";
import type { PublicView } from "./settings-types";
import { PUBLIC_MAX_FILE_BYTES, fileFieldsFor, isPublicType, parsePublicSubmission, type PublicProblems, type PublicType } from "./validate";

// ---- the form behind an address --------------------------------------------------------------------------------------------

export interface PublicFormRow {
  id: string;
  account_id: string;
  type_key: string;
  enabled: boolean;
  slug: string;
  notice: Record<string, string> | null;
  turnstile: boolean;
  max_amount: number | string;
  banks: string[] | null;
}

export const FORM_COLUMNS = "id, account_id, type_key, enabled, slug, notice, turnstile, max_amount, banks";

/** The fields a type must carry for the public form to record everything it asks. */
const REQUIRED_KEYS: Record<PublicType, string[]> = {
  closure: ["confirm_closure", "children_finished_school", "allowances_cancelled", "bank_account_is_own", "bank_name", "bank_account_number", "bank_account_holder", "authorization_letter", "declaration"],
  withdrawal: ["amount", "reason", "bank_account_is_own", "bank_name", "bank_account_number", "bank_account_holder", "authorization_letter", "declaration", "reason_kind", "proof"],
};

/** Can this type take the public form? It must be active and have every field the form fills. */
export function typeSupportsPublicForm(type: RequestTypeRow | undefined | null, kind: PublicType): boolean {
  if (!type || !type.active) return false;
  const have = new Set(type.fields.map((f) => f.key));
  return REQUIRED_KEYS[kind].every((k) => have.has(k));
}

export interface PublicForm {
  form: PublicFormRow;
  type: PublicType;
  typeRow: RequestTypeRow;
  workspace: { name: string; logoUrl: string | null };
  maxAmount: number;
}

/** The form behind an address, or null for every reason a visitor must not be told apart. */
export async function loadPublicForm(admin: SupabaseClient, rawSlug: string): Promise<PublicForm | null> {
  const slug = normalizeSlug(rawSlug);
  if (!slug) return null;
  const { data, error } = await admin.from("compliance_public_forms").select(FORM_COLUMNS).eq("slug", slug).eq("enabled", true).maybeSingle();
  if (error || !data) return null;
  const form = data as unknown as PublicFormRow;
  if (!isPublicType(form.type_key)) return null;
  if (!(await complianceEnabled(admin, form.account_id))) return null;
  const typeRow = await loadType(admin, form.account_id, form.type_key);
  if (!typeSupportsPublicForm(typeRow, form.type_key)) return null;
  const { data: acct } = await admin.from("accounts").select("name, brand_name, brand_logo_url").eq("id", form.account_id).maybeSingle();
  const a = acct as { name?: string; brand_name?: string; brand_logo_url?: string | null } | null;
  return {
    form,
    type: form.type_key,
    typeRow: typeRow as RequestTypeRow,
    workspace: { name: a?.brand_name?.trim() || a?.name || "", logoUrl: a?.brand_logo_url && /^https:\/\//.test(a.brand_logo_url) ? a.brand_logo_url : null },
    maxAmount: Number(form.max_amount),
  };
}

export function cleanNotice(notice: Record<string, string> | null | undefined): Partial<Record<CustomerLocale, string>> {
  const out: Partial<Record<CustomerLocale, string>> = {};
  for (const l of LOCALES) {
    const v = notice?.[l];
    if (typeof v === "string" && v.trim() !== "") out[l] = v.trim().slice(0, 2000);
  }
  return out;
}

export function buildPublicView(found: PublicForm, token: string, captchaKey: string | null, sessionActive: boolean): PublicView {
  return {
    slug: found.form.slug,
    type: found.type,
    workspace: found.workspace,
    notice: cleanNotice(found.form.notice),
    maxAmount: found.maxAmount,
    banks: [...banksFor(found.form.banks)],
    targetDays: found.type === "closure" ? found.typeRow.targetDays : null,
    token,
    captchaKey: found.form.turnstile ? captchaKey : null,
    sessionActive,
  };
}

/** A token for the page, or null when this server has no key to sign with. */
export const issuePageToken = (form: Pick<PublicFormRow, "id">, now: Date = new Date()): string | null => issueFormToken(form.id, now);

export type { PublicView } from "./settings-types";

// ---- the environment the routes run with ------------------------------------------------------------------------------------

export interface PublicEnv {
  admin: SupabaseClient;
  now: () => Date;
  /** true when the call is within the limit (the shared limiter in production). */
  limit: (key: string, limit: number, windowMs: number) => Promise<boolean>;
  captcha: { enabled: boolean; verify: (token: string | null, ip: string | null) => Promise<boolean> };
  notices: NoticeDeps;
}

const shortHash = (h: string | null): string => (h ?? "unknown").slice(0, 24);

async function underLimit(env: PublicEnv, key: string, budget: { limit: number; windowMs: number }): Promise<boolean> {
  return env.limit(key, budget.limit, budget.windowMs);
}

const captchaWanted = (env: PublicEnv, form: PublicFormRow) => form.turnstile && env.captcha.enabled;

// ---- asking for a code ---------------------------------------------------------------------------------------------------------

export type CodeRequestOutcome =
  | { kind: "not_found" }
  | { kind: "not_configured" }
  | { kind: "rate_limited" }
  | { kind: "invalid_email" }
  | { kind: "captcha_failed" }
  /** The code is on its way. `emailMasked` is the address as the person typed it, masked, for the page to repeat back. */
  | { kind: "ok"; emailMasked: string }
  | { kind: "send_failed" };

export interface CodeRequest {
  slug: string;
  body: unknown;
  ip: string;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function requestCode(env: PublicEnv, req: CodeRequest): Promise<CodeRequestOutcome> {
  const found = await loadPublicForm(env.admin, req.slug);
  if (!found) return { kind: "not_found" };
  if (!publicFormsConfigured()) return { kind: "not_configured" };
  const { form } = found;
  const b = asObject(req.body);
  const ipHash = hashIp(req.ip);

  if (ipHash && !(await underLimit(env, `cmp:att:ip:${shortHash(ipHash)}`, RATE_LIMITS.complianceAttemptsIp))) return { kind: "rate_limited" };
  if (!(await underLimit(env, `cmp:att:form:${form.id}`, RATE_LIMITS.complianceAttemptsForm))) return { kind: "rate_limited" };

  // a script that filled the hidden field is answered like a success and sent nothing
  if (typeof b.website === "string" && b.website.trim() !== "") return { kind: "ok", emailMasked: maskEmail(cleanEmail(b.email) ?? "x@x") };

  const email = cleanEmail(b.email);
  if (!email) return { kind: "invalid_email" };
  const emailHash = hashEmail(email);
  if (!emailHash) return { kind: "not_configured" };

  if (captchaWanted(env, form) && !(await env.captcha.verify(typeof b.captcha === "string" ? b.captcha : null, req.ip === "unknown" ? null : req.ip))) return { kind: "captcha_failed" };

  if (ipHash && !(await underLimit(env, `cmp:code:ip:${shortHash(ipHash)}`, RATE_LIMITS.complianceCodeIp))) return { kind: "rate_limited" };
  if (!(await underLimit(env, `cmp:code:email:${form.id}:${shortHash(emailHash)}`, RATE_LIMITS.complianceCodeEmail))) return { kind: "rate_limited" };
  if (!(await underLimit(env, `cmp:code:form:${form.id}`, RATE_LIMITS.complianceCodeForm))) return { kind: "rate_limited" };

  const now = env.now();
  const code = generateCode();
  const codeHash = hashCode(code, form.id, emailHash);
  if (!codeHash) return { kind: "not_configured" };

  // an earlier code for this address stops working the moment a new one is asked for
  await env.admin.from("compliance_email_codes").update({ consumed_at: now.toISOString() }).eq("form_id", form.id).eq("email_hash", emailHash).is("consumed_at", null);
  const ins = await env.admin
    .from("compliance_email_codes")
    .insert({ account_id: form.account_id, form_id: form.id, email_hash: emailHash, code_hash: codeHash, attempts: 0, expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(), ip_hash: ipHash })
    .select("id")
    .single();
  if (ins.error || !ins.data) return { kind: "send_failed" };

  const locale = (LOCALES as readonly string[]).includes(String(b.locale)) ? (b.locale as CustomerLocale) : "en";
  const mail = codeEmail({ locale, workspace: found.workspace.name || "Halo", code });
  const sent = await sendWorkspaceEmail(form.account_id, { to: email, subject: mail.subject, html: mail.html, text: mail.text }, env.notices.mail);
  if (sent.status !== "sent") {
    // the code can never be used: take it back so it does not count as one of the hour's three
    await env.admin.from("compliance_email_codes").update({ consumed_at: now.toISOString() }).eq("id", (ins.data as { id: string }).id);
    return { kind: "send_failed" };
  }
  return { kind: "ok", emailMasked: maskEmail(email) };
}

// ---- entering the code -----------------------------------------------------------------------------------------------------------

export type CodeVerifyOutcome =
  | { kind: "not_found" }
  | { kind: "not_configured" }
  | { kind: "rate_limited" }
  | { kind: "invalid_email" }
  | { kind: "no_code" }
  | { kind: "expired" }
  | { kind: "too_many_attempts" }
  | { kind: "wrong"; attemptsLeft: number }
  /** The address is confirmed: the route sets this cookie. */
  | { kind: "ok"; cookie: { name: string; value: string; maxAgeSeconds: number }; emailMasked: string };

export async function verifyCode(env: PublicEnv, req: CodeRequest): Promise<CodeVerifyOutcome> {
  const found = await loadPublicForm(env.admin, req.slug);
  if (!found) return { kind: "not_found" };
  if (!publicFormsConfigured()) return { kind: "not_configured" };
  const { form } = found;
  const b = asObject(req.body);
  const ipHash = hashIp(req.ip);
  if (ipHash && !(await underLimit(env, `cmp:att:ip:${shortHash(ipHash)}`, RATE_LIMITS.complianceAttemptsIp))) return { kind: "rate_limited" };
  if (!(await underLimit(env, `cmp:att:form:${form.id}`, RATE_LIMITS.complianceAttemptsForm))) return { kind: "rate_limited" };

  const email = cleanEmail(b.email);
  if (!email) return { kind: "invalid_email" };
  const emailHash = hashEmail(email);
  const entered = typeof b.code === "string" ? b.code.replace(/\s+/g, "") : "";
  if (!emailHash) return { kind: "not_configured" };
  if (!/^\d{6}$/.test(entered)) return { kind: "wrong", attemptsLeft: CODE_MAX_ATTEMPTS };

  const now = env.now();
  const latest = await env.admin.from("compliance_email_codes").select("id, code_hash, expires_at, attempts, consumed_at").eq("form_id", form.id).eq("email_hash", emailHash).is("consumed_at", null).order("created_at", { ascending: false }).limit(1);
  const row = ((latest.data ?? []) as { id: string; code_hash: string; expires_at: string; attempts: number; consumed_at: string | null }[])[0];
  if (latest.error || !row) return { kind: "no_code" };
  if (Date.parse(row.expires_at) <= now.getTime()) return { kind: "expired" };

  // the try is counted BEFORE it is judged, and only while tries are left: a crash cannot grant a free guess and two at once cannot both be the fifth
  const counted = await env.admin.from("compliance_email_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id).eq("attempts", row.attempts).lt("attempts", CODE_MAX_ATTEMPTS).select("id, code_hash, expires_at, attempts, consumed_at");
  const mine = ((counted.data ?? []) as { id: string; code_hash: string; expires_at: string; attempts: number; consumed_at: string | null }[])[0];
  if (counted.error || !mine) return { kind: row.attempts >= CODE_MAX_ATTEMPTS ? "too_many_attempts" : "rate_limited" };

  const verdict = checkCode(mine, entered, form.id, emailHash, now);
  if (!verdict.ok) {
    if (verdict.reason === "wrong") return { kind: "wrong", attemptsLeft: verdict.attemptsLeft };
    return { kind: verdict.reason === "expired" ? "expired" : verdict.reason === "too_many_attempts" ? "too_many_attempts" : "no_code" };
  }
  // used once: the same code cannot start a second session
  const used = await env.admin.from("compliance_email_codes").update({ consumed_at: now.toISOString() }).eq("id", mine.id).is("consumed_at", null).select("id");
  if (used.error || ((used.data ?? []) as unknown[]).length !== 1) return { kind: "no_code" };
  const session = createSession(form.id, emailHash, now);
  if (!session) return { kind: "not_configured" };
  return { kind: "ok", cookie: { name: sessionCookieName(form.slug), value: session.value, maxAgeSeconds: session.maxAgeSeconds }, emailMasked: maskEmail(email) };
}

// ---- the submission --------------------------------------------------------------------------------------------------------------

export interface UploadedPart {
  bytes: Uint8Array;
  name: string;
}

export interface SubmitRequest {
  slug: string;
  /** The "payload" of the multipart post, already parsed from JSON (anything else is {}). */
  body: unknown;
  files: { letter?: UploadedPart | null; proof?: UploadedPart | null };
  /** The value of the session cookie, if any. */
  sessionValue: string | null;
  ip: string;
}

export type RetryCode = "token_invalid" | "token_expired" | "token_too_fast";

export type SubmitOutcome =
  | { kind: "not_found" }
  | { kind: "not_configured" }
  | { kind: "rate_limited" }
  /** The details are not acceptable: which ones and why, for the page to word. */
  | { kind: "invalid"; problems: PublicProblems }
  /** Try again with this fresh page token. */
  | { kind: "retry"; code: RetryCode; token: string }
  /** The session is missing, expired or for another address: confirm the address again. */
  | { kind: "session_invalid" }
  /** The parent chose not to close the account: nothing was created. */
  | { kind: "declined" }
  /** Taken. `reference` is the case's (a repeat gets the existing one). Null only for a script that filled the hidden field. */
  | { kind: "ok"; reference: string | null }
  | { kind: "failed" };

const OPEN_STATUSES = ["received", "identity_check", "officer_review", "awaiting_signoff", "approved", "executing"];

/** The reference of an OPEN request of this type for this address (any source), or null. */
async function findOpenRequest(admin: SupabaseClient, accountId: string, typeKey: string, email: string): Promise<string | null> {
  const { data, error } = await admin.from("compliance_requests").select("reference, customer_email, status").eq("account_id", accountId).eq("type_key", typeKey).ilike("customer_email", email.replace(/[\\%_]/g, (m) => `\\${m}`)).in("status", OPEN_STATUSES).limit(20);
  if (error) throw new Error("repeat check failed");
  const hit = ((data ?? []) as { reference: string; customer_email: string | null }[]).find((r) => (r.customer_email ?? "").trim().toLowerCase() === email);
  return hit?.reference ?? null;
}

/** The contact of THIS workspace that is plainly this person: exactly one by email, else exactly one by phone. Never creates one. */
export async function matchContact(admin: SupabaseClient, accountId: string, email: string, phone: string): Promise<string | null> {
  const byEmail = await admin.from("contacts").select("id, email").eq("account_id", accountId).is("deleted_at", null).ilike("email", email.replace(/[\\%_]/g, (m) => `\\${m}`)).limit(5);
  const emailHits = ((byEmail.data ?? []) as { id: string; email: string | null }[]).filter((c) => (c.email ?? "").trim().toLowerCase() === email);
  if (emailHits.length === 1) return emailHits[0].id;
  if (emailHits.length > 1) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const byPhone = await admin.from("contacts").select("id").eq("account_id", accountId).is("deleted_at", null).eq("phone_normalized", digits).limit(3);
  const phoneHits = (byPhone.data ?? []) as { id: string }[];
  return phoneHits.length === 1 ? phoneHits[0].id : null;
}

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string } | null;
  return !!err && (err.code === "23505" || err.code === "duplicate_open" || /duplicate key|unique constraint|duplicate_open/i.test(err.message ?? ""));
};

function filesProblems(files: SubmitRequest["files"], type: PublicType, needsLetter: boolean): PublicProblems {
  const problems: PublicProblems = {};
  for (const f of fileFieldsFor(type)) {
    // a letter sent with "this account is mine" is dropped: not looked at, not stored
    if (f.id === "letter" && !needsLetter) continue;
    const part = files[f.id];
    if (!part || part.bytes.byteLength === 0) {
      if (f.id === "letter" && needsLetter) problems.letter = "file_required";
      continue;
    }
    if (part.bytes.byteLength > PUBLIC_MAX_FILE_BYTES) problems[f.id] = "file_size";
    else if (!detectFileKind(part.bytes)) problems[f.id] = "file_type";
  }
  return problems;
}

export async function submitPublicForm(env: PublicEnv, req: SubmitRequest): Promise<SubmitOutcome> {
  const found = await loadPublicForm(env.admin, req.slug);
  if (!found) return { kind: "not_found" };
  if (!publicFormsConfigured()) return { kind: "not_configured" };
  const { form } = found;
  const now = env.now();
  const b = asObject(req.body);
  const ipHash = hashIp(req.ip);
  const fresh = (): string => issueFormToken(form.id, env.now()) ?? "";

  // 1. how often: every post counts, valid or not
  if (ipHash && !(await underLimit(env, `cmp:att:ip:${shortHash(ipHash)}`, RATE_LIMITS.complianceAttemptsIp))) return { kind: "rate_limited" };
  if (!(await underLimit(env, `cmp:att:form:${form.id}`, RATE_LIMITS.complianceAttemptsForm))) return { kind: "rate_limited" };

  // 2. a script is judged before anything is looked at: the hidden field, then the token
  if (typeof b.website === "string" && b.website.trim() !== "") return { kind: "ok", reference: null };
  const token = readFormToken(b.token, form.id, now);
  if (!token.ok) return { kind: "retry", code: token.reason, token: fresh() };

  // 3. the address the person proved, and the same one typed again
  const email = cleanEmail(b.email);
  const session = readSession(req.sessionValue, form.id, now);
  if (!email || !session.ok || !sessionHolds(session, email)) return { kind: "session_invalid" };
  if (isTooFast(token.ageMs) || now.getTime() - session.issuedAtMs < MIN_FILL_AFTER_VERIFY_MS) return { kind: "retry", code: "token_too_fast", token: fresh() };

  // 4. the details and the files
  const checked = parsePublicSubmission(found.type, b, { maxAmount: found.maxAmount, banks: banksFor(form.banks) });
  if (!checked.ok) return { kind: "invalid", problems: checked.problems };
  if ("declined" in checked) return { kind: "declined" };
  const { value } = checked;
  const fileProblems = filesProblems(req.files, found.type, value.needsLetter);
  if (Object.keys(fileProblems).length > 0) return { kind: "invalid", problems: fileProblems };

  // 5. the checks that cost something
  if (ipHash && !(await underLimit(env, `cmp:sub:ip:${shortHash(ipHash)}`, RATE_LIMITS.complianceSubmitIp))) return { kind: "rate_limited" };
  if (!(await underLimit(env, `cmp:sub:form:${form.id}`, RATE_LIMITS.complianceSubmitForm))) return { kind: "rate_limited" };
  const emailHash = hashEmail(email);
  if (emailHash && !(await underLimit(env, `cmp:sub:email:${shortHash(emailHash)}`, RATE_LIMITS.complianceSubmitEmail))) return { kind: "rate_limited" };

  // the language the parent chose on the form; none chosen: the contact's, else English (languageFor decides when an email goes out)
  const locale: CustomerLocale | null = (LOCALES as readonly string[]).includes(String(b.locale)) ? (b.locale as CustomerLocale) : null;
  const stored: { part: "letter" | "proof"; fieldKey: string; file: StoredEvidence }[] = [];
  let requestId: string | null = null;
  try {
    // 6. a repeat: the same confirmation, nothing created
    const existing = await findOpenRequest(env.admin, form.account_id, found.type, email);
    if (existing) return { kind: "ok", reference: existing };

    // 7. the files go into the private bucket under the case's folder BEFORE the case exists: a letter that could not be stored must not leave a
    //    closure that needs one without it
    requestId = randomUUID();
    for (const f of fileFieldsFor(found.type)) {
      if (f.id === "letter" && !value.needsLetter) continue;
      const part = req.files[f.id];
      if (!part || part.bytes.byteLength === 0) continue;
      stored.push({ part: f.id, fieldKey: f.fieldKey, file: await putEvidence(env.admin, form.account_id, requestId, part) });
    }

    // 8. the case
    const contactId = await matchContact(env.admin, form.account_id, email, value.phone);
    const created = await createComplianceRequest(env.admin, {
      id: requestId,
      accountId: form.account_id,
      typeKey: found.type,
      source: "form",
      channel: "web_form",
      customerName: value.name,
      customerEmail: email,
      customerPhone: value.phone,
      answers: value.answers,
      createdBy: null,
      contactId,
      customerLocale: locale,
      emailVerifiedAt: new Date(session.issuedAtMs).toISOString(),
    });
    for (const s of stored) {
      try {
        await recordEvidence(env.admin, form.account_id, created.id, s.file, s.fieldKey, null);
      } catch {
        // the case is made; a file row that could not be written is on the record and the officer asks the parent for it
        console.error("[compliance] a form file could not be recorded");
      }
    }

    // 9. the confirmation to the parent (never an error for them)
    await sendCustomerNotice(env.admin, env.notices, { accountId: form.account_id, requestId: created.id, kind: "received", actor: null, language: null }).catch(() => undefined);
    return { kind: "ok", reference: created.reference };
  } catch (err) {
    // objects already stored for a case that was not made
    if (stored.length > 0) await env.admin.storage.from(COMPLIANCE_BUCKET).remove(stored.map((s) => s.file.path)).catch(() => undefined);
    if (isUniqueViolation(err) || (err instanceof ComplianceError && err.code === "duplicate_open")) {
      // two posts at the same moment: the other one made the case
      try {
        const existing = await findOpenRequest(env.admin, form.account_id, found.type, email);
        if (existing) return { kind: "ok", reference: existing };
      } catch {
        // fall through to a failure
      }
    }
    if (err instanceof ComplianceError && (err.code === "validation_failed" || err.code === "unsupported_file" || err.code === "file_too_large")) return { kind: "invalid", problems: {} };
    console.error("[compliance] a public form submission failed:", err instanceof Error ? err.name : "error");
    return { kind: "failed" };
  }
}

