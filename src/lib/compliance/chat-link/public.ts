// ============================================================
// Compliance requests, the personal closure form (/c/link/<token>), the server side (migration 185). What happens when the parent taps the button in their
// chat. SERVER ONLY.
//
// The link is the parent's key: 256 random bits, personal to ONE case, single-use, expiring (14 days). There is no emailed code on this form: the parent is
// already talking to us in that chat, and the link was sent into it by a member of staff. They type their email address (required, only validated: it is not
// proved) and fill the SAME closure form as the public one (/c/<slug>): the acknowledgements, "does this bank account belong to you?", the bank
// details, the authorization letter when the answer is No, the declaration. The name comes from the contact and can be corrected; the registered phone number comes from the
// chat, is shown masked and cannot be edited.
//
// ONE neutral answer. An unknown, malformed, expired, used, withdrawn or replaced link, a workspace with Compliance off, a case that has moved on to sign-off or
// is closed, a form that cannot take the fields: all are "not found" and the page says one calm sentence. Nothing says which, or whether a request exists.
//
// The token is looked up by the link id half (not a secret) and the keyed hash of the whole token is compared in constant time (token.ts).
//
// The submission UPDATES THE EXISTING CASE (no new case): the protected answers are encrypted into data_enc exactly as in Part A and B, the ordinary ones are
// merged into data, the name and the email typed are stored, the files go into the private bucket, and compliance_apply_form_link marks the link used and
// applies it in ONE transaction, so a double submit cannot apply twice. The identity check stays NOT done. Then, best effort, the people who review closures
// are notified and the conversation gets an internal note "Closure form submitted · CMP-...".
//
// What the page shows back: the case's reference and the words of what happens next. Everything the parent typed is never displayed back.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { postInternalComment } from "@/lib/conversations/comment-write";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { isTooFast, issueFormToken, readFormToken } from "@/lib/sign/registration/token";

import { NAME_DIFFERS_KEY, nameDiffersFlag } from "../bank-own";
import { complianceEnabled } from "../feature";
import { checkAnswers } from "../fields";
import { formSubmittedNoteText } from "../raised-note";
import { cleanEmail } from "../public/amount";
import { banksFor } from "../public/banks";
import { hashIp } from "../public/session";
import { PUBLIC_MAX_FILE_BYTES, fileFieldsFor, parsePublicSubmission, type PublicProblems } from "../public/validate";
import { typeSupportsPublicForm, type PublicEnv, type RetryCode, type UploadedPart } from "../public/service";
import { COMPLIANCE_BUCKET, putEvidence, recordEvidence, type StoredEvidence } from "../service/files";
import { holdersOf, loadRow, loadType } from "../service/read";
import type { RequestRow } from "../service/rows";
import { openSensitive, sealSensitive } from "../secrets";
import { LOCALES, type CustomerLocale } from "../types";
import { cardLocaleOf } from "./card";
import { maskPhone } from "./mask";
import { isActiveLink, type LinkTimes } from "./link-state";
import { linkIdOf, linkTokensConfigured, tokenMatches } from "./token";
import type { LinkView } from "./types";

export type { LinkView };

interface LinkRow extends LinkTimes {
  id: string;
  account_id: string;
  request_id: string;
  token_hash: string;
  conversation_id: string | null;
  channel: string | null;
  locale: string | null;
  created_by: string | null;
}

const LINK_FULL = "id, account_id, request_id, token_hash, conversation_id, channel, locale, created_by, created_at, expires_at, sent_at, opened_at, submitted_at, revoked_at, revoked_reason";
/** What a missing link is compared against, so a link that does not exist takes about as long as one that does. */
const NO_HASH = "0".repeat(64);
const EDITABLE = ["received", "identity_check", "officer_review"];

interface Found {
  link: LinkRow;
  row: RequestRow;
}

/**
 * The link behind a token, only when it is genuine and can still be used: the token matches its keyed hash (constant time), the link is not used, withdrawn,
 * replaced or expired, the workspace has Compliance on, and the case is still a closure that can take the form. Null for every other reason.
 */
export async function findLink(admin: SupabaseClient, token: unknown, now: Date): Promise<Found | null> {
  if (!linkTokensConfigured()) return null;
  const id = linkIdOf(token);
  if (!id) return null;
  const { data, error } = await admin.from("compliance_form_links").select(LINK_FULL).eq("id", id).maybeSingle();
  const link = (error ? null : data) as LinkRow | null;
  const genuine = tokenMatches(token, link?.token_hash ?? NO_HASH);
  if (!link || !genuine) return null;
  if (!isActiveLink(link, now)) return null;
  if (!(await complianceEnabled(admin, link.account_id))) return null;
  let row: RequestRow;
  try {
    row = await loadRow(admin, link.account_id, link.request_id);
  } catch {
    return null;
  }
  if (row.type_key !== "closure" || !EDITABLE.includes(row.status)) return null;
  const type = await loadType(admin, link.account_id, "closure");
  if (!typeSupportsPublicForm(type, "closure")) return null;
  return { link, row };
}

// ---- limits ------------------------------------------------------------------------------------------------------------------

const shortHash = (h: string | null): string => (h ?? "unknown").slice(0, 24);
const within = (env: PublicEnv, key: string, budget: { limit: number; windowMs: number }): Promise<boolean> => env.limit(key, budget.limit, budget.windowMs);

// ---- drawing the page ---------------------------------------------------------------------------------------------------------

export type LinkPageOutcome = { kind: "ok"; view: LinkView } | { kind: "busy" } | { kind: "invalid" };

/** The data for GET /c/link/<token>. Rate limited per caller address; the first successful open is recorded (once). */
export async function loadLinkPage(env: PublicEnv, token: string, ip: string, preferredLocale: CustomerLocale | null): Promise<LinkPageOutcome> {
  const ipHash = hashIp(ip);
  if (ipHash && !(await within(env, `cmp:link:att:ip:${shortHash(ipHash)}`, RATE_LIMITS.complianceLinkAttemptsIp))) return { kind: "busy" };
  const now = env.now();
  const found = await findLink(env.admin, token, now);
  if (!found) return { kind: "invalid" };
  const { link, row } = found;
  if (!(await within(env, `cmp:link:att:link:${link.id}`, RATE_LIMITS.complianceLinkAttemptsLink))) return { kind: "busy" };
  const formToken = issueFormToken(link.id, now);
  if (!formToken) return { kind: "invalid" };

  // recorded once, best effort: a page that cannot be recorded as opened is still a page
  await env.admin.rpc("compliance_form_link_opened", { p_link: link.id }).then(undefined, () => undefined);

  const [acct, form, contact] = await Promise.all([
    env.admin.from("accounts").select("name, brand_name, brand_logo_url").eq("id", link.account_id).maybeSingle(),
    env.admin.from("compliance_public_forms").select("banks").eq("account_id", link.account_id).eq("type_key", "closure").maybeSingle(),
    row.contact_id ? env.admin.from("contacts").select("name, email, language").eq("id", row.contact_id).eq("account_id", link.account_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const a = acct.data as { name?: string; brand_name?: string; brand_logo_url?: string | null } | null;
  const c = contact.data as { name?: string | null; email?: string | null; language?: string | null } | null;
  const type = await loadType(env.admin, link.account_id, "closure");
  const locale = cardLocaleOf(link.locale) ?? cardLocaleOf(row.customer_locale) ?? cardLocaleOf(c?.language) ?? preferredLocale ?? "en";
  return {
    kind: "ok",
    view: {
      token: formToken,
      linkToken: token,
      workspace: { name: a?.brand_name?.trim() || a?.name || "", logoUrl: a?.brand_logo_url && /^https:\/\//.test(a.brand_logo_url) ? a.brand_logo_url : null },
      maskedPhone: row.customer_phone ? maskPhone(row.customer_phone) || null : null,
      name: (row.customer_name || c?.name || "").trim(),
      email: (row.customer_email || c?.email || "").trim(),
      banks: [...banksFor((form.data as { banks?: string[] | null } | null)?.banks ?? null)],
      targetDays: type?.targetDays ?? null,
      locale,
    },
  };
}

// ---- the submission -----------------------------------------------------------------------------------------------------------

export interface LinkSubmitRequest {
  /** The "payload" of the multipart post, already parsed from JSON. */
  body: unknown;
  files: { letter?: UploadedPart | null; proof?: UploadedPart | null };
  ip: string;
}

export type LinkSubmitOutcome =
  /** An unknown, used, withdrawn, replaced or expired link: ONE answer for all of them. */
  | { kind: "not_found" }
  | { kind: "not_configured" }
  | { kind: "rate_limited" }
  | { kind: "invalid"; problems: PublicProblems }
  | { kind: "retry"; code: RetryCode; token: string }
  /** The parent chose not to close the account: nothing was changed and the link still works. */
  | { kind: "declined" }
  /** Taken. `reference` is the case's. Null only for a script that filled the hidden field. */
  | { kind: "ok"; reference: string | null }
  | { kind: "failed" };

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function fileProblems(files: LinkSubmitRequest["files"], needsLetter: boolean, detect: (b: Uint8Array) => unknown): PublicProblems {
  const problems: PublicProblems = {};
  for (const f of fileFieldsFor("closure")) {
    // a letter sent with "this account is mine" is dropped: not looked at, not stored
    if (f.id === "letter" && !needsLetter) continue;
    const part = files[f.id];
    if (!part || part.bytes.byteLength === 0) {
      if (f.id === "letter" && needsLetter) problems.letter = "file_required";
      continue;
    }
    if (part.bytes.byteLength > PUBLIC_MAX_FILE_BYTES) problems[f.id] = "file_size";
    else if (!detect(part.bytes)) problems[f.id] = "file_type";
  }
  return problems;
}

export async function submitLinkForm(env: PublicEnv, req: LinkSubmitRequest, detect: (b: Uint8Array) => unknown): Promise<LinkSubmitOutcome> {
  if (!linkTokensConfigured()) return { kind: "not_configured" };
  const now = env.now();
  const b = asObject(req.body);
  const ipHash = hashIp(req.ip);

  // 1. how often: every post counts, valid or not (a wrong token too)
  if (ipHash && !(await within(env, `cmp:link:att:ip:${shortHash(ipHash)}`, RATE_LIMITS.complianceLinkAttemptsIp))) return { kind: "rate_limited" };

  // 2. a script is judged before anything is looked at
  if (typeof b.website === "string" && b.website.trim() !== "") return { kind: "ok", reference: null };

  // 3. the link (one answer for every reason it does not work)
  const found = await findLink(env.admin, b.linkToken, now);
  if (!found) return { kind: "not_found" };
  const { link, row } = found;
  if (!(await within(env, `cmp:link:att:link:${link.id}`, RATE_LIMITS.complianceLinkAttemptsLink))) return { kind: "rate_limited" };

  // 4. the page's token: genuine, for THIS link, 3 seconds to 2 hours old
  const fresh = (): string => issueFormToken(link.id, env.now()) ?? "";
  const token = readFormToken(b.token, link.id, now);
  if (!token.ok) return { kind: "retry", code: token.reason, token: fresh() };
  if (isTooFast(token.ageMs)) return { kind: "retry", code: "token_too_fast", token: fresh() };

  // 5. the details: the closure form's own rules, the email typed, the phone only when the case has none
  const type = await loadType(env.admin, link.account_id, "closure");
  if (!type || !typeSupportsPublicForm(type, "closure")) return { kind: "not_found" };
  const form = await env.admin.from("compliance_public_forms").select("banks").eq("account_id", link.account_id).eq("type_key", "closure").maybeSingle();
  const checked = parsePublicSubmission("closure", b, { maxAmount: 0, banks: banksFor((form.data as { banks?: string[] | null } | null)?.banks ?? null), phoneFromCase: row.customer_phone !== null && row.customer_phone !== "" });
  if ("declined" in checked && checked.ok) return { kind: "declined" };
  const email = cleanEmail(b.email);
  const problems: PublicProblems = checked.ok ? {} : { ...checked.problems };
  if (!email) problems.email = typeof b.email === "string" && b.email.trim() !== "" ? "invalid" : "required";
  if (!checked.ok || "declined" in checked || !email) return { kind: "invalid", problems };
  const { value } = checked;
  const fp = fileProblems(req.files, value.needsLetter, detect);
  if (Object.keys(fp).length > 0) return { kind: "invalid", problems: fp };

  // 6. the checks that cost something
  if (ipHash && !(await within(env, `cmp:link:sub:ip:${shortHash(ipHash)}`, RATE_LIMITS.complianceLinkSubmitIp))) return { kind: "rate_limited" };

  // 7. the answers, encrypted exactly as a case made any other way, merged with what is already protected on this case
  const answers = checkAnswers(type.fields, value.answers);
  if (!answers.ok) return { kind: "invalid", problems: {} };
  // migration 186: the staff flag, computed here from what was typed; it is stored with the case and never sent back to the page
  const differs = nameDiffersFlag(answers.answers.data, answers.answers.sensitive, value.name);
  const caseData = differs === null ? answers.answers.data : { ...answers.answers.data, [NAME_DIFFERS_KEY]: differs };
  let dataEnc: string | null;
  try {
    dataEnc = sealSensitive(row.id, { ...openSensitive(row.id, row.data_enc), ...answers.answers.sensitive });
  } catch {
    return { kind: "failed" };
  }

  // 8. the files go into the private bucket under the case's folder first; the claim and the update are ONE database step
  const stored: { fieldKey: string; file: StoredEvidence }[] = [];
  const cleanup = async () => {
    if (stored.length > 0) await env.admin.storage.from(COMPLIANCE_BUCKET).remove(stored.map((s) => s.file.path)).catch(() => undefined);
  };
  try {
    for (const f of fileFieldsFor("closure")) {
      if (f.id === "letter" && !value.needsLetter) continue;
      const part = req.files[f.id];
      if (!part || part.bytes.byteLength === 0) continue;
      stored.push({ fieldKey: f.fieldKey, file: await putEvidence(env.admin, link.account_id, row.id, part) });
    }
    const locale: CustomerLocale | null = (LOCALES as readonly string[]).includes(String(b.locale)) ? (b.locale as CustomerLocale) : null;
    const applied = await env.admin.rpc("compliance_apply_form_link", {
      p_link: link.id,
      p_name: value.name,
      p_email: email,
      p_phone: row.customer_phone ? null : value.phone || null,
      p_data: caseData,
      p_data_enc: dataEnc,
      p_locale: locale,
    });
    if (applied.error) {
      await cleanup();
      // used by a double submit a moment ago, or no longer applicable: the same neutral answer
      return /compliance_form_link_invalid/.test(applied.error.message ?? "") ? { kind: "not_found" } : { kind: "failed" };
    }
    const result = applied.data as { reference: string; conversation_id: string | null; created_by: string | null };
    for (const s of stored) {
      try {
        await recordEvidence(env.admin, link.account_id, row.id, s.file, s.fieldKey, null);
      } catch {
        // the case is updated; a file row that could not be written is on the record and the officer asks the parent for it
        console.error("[compliance] a form file could not be recorded");
      }
    }
    await afterSubmit(env.admin, { accountId: link.account_id, requestId: row.id, reference: result.reference, conversationId: result.conversation_id, author: result.created_by });
    return { kind: "ok", reference: result.reference };
  } catch {
    await cleanup();
    console.error("[compliance] a closure form submission failed");
    return { kind: "failed" };
  }
}

/** Best effort, never an error for the parent: tell the people who review closures, and leave a line on the conversation. */
async function afterSubmit(admin: SupabaseClient, a: { accountId: string; requestId: string; reference: string; conversationId: string | null; author: string | null }): Promise<void> {
  try {
    const holders = await holdersOf(admin, a.accountId, "compliance.review");
    if (holders.length > 0) {
      await admin.from("notifications").insert(
        holders.map((user_id) => ({ account_id: a.accountId, user_id, type: "compliance_form", title: `${a.reference}: closure form received`, body: `Compliance request ${a.reference}`, compliance_request_id: a.requestId })),
      );
    }
  } catch {
    console.error("[compliance] the closure form notifications could not be written");
  }
  if (a.conversationId && a.author) {
    try {
      await postInternalComment(admin, { accountId: a.accountId, conversationId: a.conversationId, userId: a.author, text: formSubmittedNoteText(a.reference) });
    } catch {
      console.error("[compliance] the note about a closure form could not be written");
    }
  }
}
