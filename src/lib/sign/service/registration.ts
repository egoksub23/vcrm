// ============================================================
// Registration pages, the public side (migration 164, F-58): what happens when a stranger opens /r/<slug> and
// posts the form. No login, so this is where the guards are.
//
//   1. The form must exist, be switched on, and its workspace must have Doc Sign on. Anything else is one
//      plain "not found", never saying which.
//   2. Limits per address and per form (shared across app instances), the hidden field, the signed form token
//      (genuine, for this form, under two hours old, at least three seconds old), the optional Turnstile check.
//      The address is only ever used as a keyed hash.
//   3. Strict checks on what was typed (validate.ts).
//   4. The same email starts at most one open document per form in 24 hours; a repeat is answered exactly like
//      a first time, so the page never says whether an address was known.
//   5. The contact is found or made (registration-contact.ts), the form's tag is applied (which fires the
//      workspace's tag automations once), and, when the form sends a document, it is made from the template and
//      sent through the same services every other path uses: createDraftFromTemplate, updateDraft, setSigners,
//      sendDocument (the monthly limit and the audit trail live there). The applicant is the form's role, the
//      other roles are the people the form names.
//   6. Every outcome is one row in sign_registrations. The row is written first as "in progress" so two posts
//      at the same moment cannot both pass the repeat check (the earlier one wins), then settled.
//
// Nothing here ever returns a link: the applicant gets the document in their email, which is also what proves
// the address is theirs. A document that could not be delivered or sent is a "failed" row and a neutral message.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { UsageLimitError } from "@/lib/platform/usage";
import { RATE_LIMITS } from "@/lib/rate-limit";

import { signEnabled } from "../feature";
import type { NotifyDeps } from "../notify";
import { registrationConsentFor } from "../registration/consent";
import { mergeValuesFor } from "../registration/merge";
import { normalizeSlug } from "../registration/slug";
import { hashEmail, hashIp, isTooFast, issueFormToken, readFormToken, registrationConfigured } from "../registration/token";
import type { AskedFields, RegistrationFormRow, RegistrationStatus } from "../registration/types";
import { parseSubmission, peekTrap, type DetailProblem, type Submission } from "../registration/validate";
import { SIGN_LOCALES, type SignLocale } from "../types";
import { loadSenderAndWorkspace, type SignCtx } from "./context";
import { createDraftFromTemplate, deleteDraft, setSigners, updateDraft } from "./drafts";
import { SignError } from "./errors";
import { formReadiness, loadTemplateStates } from "./registration-forms";
import { upsertApplicantContact } from "./registration-contact";
import { sendDocument } from "./send";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A claim that is older than this was left by a request that died: it no longer holds up a repeat. */
const CLAIM_MS = 2 * 60 * 1000;

// ---- the page ------------------------------------------------------------------------------------------

/** Nothing the page reads needs to send a message, so it carries no delivery. */
const noDeps = {} as NotifyDeps;

function systemCtx(admin: SupabaseClient, accountId: string, origin: string, deps: NotifyDeps, now: () => Date): SignCtx {
  return { admin, accountId, userId: null, origin, deps, now };
}

export interface PublicForm {
  form: RegistrationFormRow;
  workspace: { name: string; logoUrl: string | null };
}

/** The form behind an address, or null for every reason a visitor must not be told apart: unknown, off, Doc Sign off. */
export async function loadPublicForm(admin: SupabaseClient, rawSlug: string, origin = ""): Promise<PublicForm | null> {
  const slug = normalizeSlug(rawSlug);
  if (!slug) return null;
  const { data, error } = await admin.from("sign_registration_forms").select("*").eq("slug", slug).eq("active", true).maybeSingle();
  if (error || !data) return null;
  const form = data as RegistrationFormRow;
  if (!(await signEnabled(admin, form.account_id))) return null;
  const ctx = systemCtx(admin, form.account_id, origin, noDeps, () => new Date());
  const info = await loadSenderAndWorkspace(ctx, null);
  return { form, workspace: { name: info.workspaceName, logoUrl: info.logoUrl } };
}

/** What the page needs, safe to hand to the browser (no secret, no other form's anything). */
export interface RegisterView {
  slug: string;
  workspace: { name: string; logoUrl: string | null };
  asked: AskedFields;
  defaultLocale: SignLocale;
  /** The form starts a document (its success words say the document was emailed) or only takes the details. */
  sendsDocument: boolean;
  /** What it starts: an agreement to sign, or a form without a signature (the words then say "complete your details", not "read and sign"). Absent is `sign`. */
  documentMode?: "sign" | "form";
  /** The agreement's words per language, with the workspace's name in them. */
  consent: Record<SignLocale, string>;
  /** The form's own thank-you words per language; a language left out uses the product's. */
  success: Partial<Record<SignLocale, string>>;
  token: string;
  /** The Turnstile site key, or null when Turnstile is off. */
  captchaKey: string | null;
}

export function buildRegisterView(found: PublicForm, token: string, captchaKey: string | null): RegisterView {
  const { form, workspace } = found;
  return {
    slug: form.slug,
    workspace,
    asked: form.fields,
    defaultLocale: form.default_locale,
    sendsDocument: form.send_document,
    documentMode: form.mode === "form" ? "form" : "sign",
    consent: Object.fromEntries(SIGN_LOCALES.map((l) => [l, registrationConsentFor(form.consent_text, l, workspace.name).text])) as Record<SignLocale, string>,
    success: { ...form.success_message },
    token,
    captchaKey,
  };
}

/** A token for the page, or null when this server has no key to sign with. */
export const issuePageToken = (form: Pick<RegistrationFormRow, "id">, now: Date = new Date()): string | null => issueFormToken(form.id, now);

// ---- the submission ------------------------------------------------------------------------------------

export interface SubmitEnv {
  admin: SupabaseClient;
  origin: string;
  deps: NotifyDeps;
  now: () => Date;
  /** true when the call is within the limit (the shared limiter in production). */
  limit: (key: string, limit: number, windowMs: number) => Promise<boolean>;
  captcha: { enabled: boolean; verify: (token: string | null, ip: string | null) => Promise<boolean> };
}

export interface SubmitRequest {
  slug: string;
  body: unknown;
  ip: string;
  userAgent: string | null;
}

export type RetryCode = "token_invalid" | "token_expired" | "token_too_fast" | "captcha_failed";

export type SubmitOutcome =
  | { kind: "not_found" }
  | { kind: "not_configured" }
  | { kind: "rate_limited" }
  /** The details are not acceptable: which ones and why, for the page to word. */
  | { kind: "invalid"; problems: Partial<Record<string, DetailProblem>> }
  /** Try again with this fresh token (and the widget's token, for `captcha_failed`). */
  | { kind: "retry"; code: RetryCode; token: string }
  /** The form has taken as many as it takes today. */
  | { kind: "cap" }
  /** Taken: a first registration, a repeat, or one a script made. The page cannot tell which and neither can the sender of a script. */
  | { kind: "ok" }
  /** Could not be completed on our side (monthly limit, delivery); the workspace's people can see why. `saved`: the person's details are in the workspace's contacts, so it can reach them. */
  | { kind: "failed"; saved: boolean };

const shortHash = (hash: string | null): string => (hash ?? "unknown").slice(0, 24);

interface EntryRow {
  status: RegistrationStatus;
  reason: string | null;
  email_hash?: string | null;
  contact_id?: string | null;
  document_id?: string | null;
}

async function insertEntry(admin: SupabaseClient, accountId: string, formId: string, base: Record<string, unknown>, row: EntryRow): Promise<{ id: string; created_at: string } | null> {
  const { data, error } = await admin.from("sign_registrations").insert({ ...base, ...row, account_id: accountId, form_id: formId }).select("id, created_at").single();
  if (error || !data) {
    console.error("[sign] could not record a registration:", error?.message);
    return null;
  }
  return data as { id: string; created_at: string };
}

async function settleEntry(admin: SupabaseClient, accountId: string, id: string, patch: Partial<EntryRow> & { status: RegistrationStatus }): Promise<void> {
  const { error } = await admin.from("sign_registrations").update(patch).eq("id", id).eq("account_id", accountId);
  if (error) console.error("[sign] could not settle a registration:", error.message);
}

const OPEN = ["draft", "sent", "in_progress"];

/**
 * An earlier registration of the same email on this form that already stands for it: a document still open (or,
 * for a form that sends none, any acceptance) in the last 24 hours, or another request of the same email that
 * began first and is still being handled.
 */
async function findPrior(env: SubmitEnv, form: RegistrationFormRow, mine: { id: string; created_at: string }, emailHash: string): Promise<{ contact_id: string | null; document_id: string | null } | null> {
  const since = new Date(env.now().getTime() - DAY_MS).toISOString();
  const r = await env.admin.from("sign_registrations").select("*").eq("account_id", form.account_id).eq("form_id", form.id).eq("email_hash", emailHash).gte("created_at", since).order("created_at", { ascending: true }).limit(50);
  if (r.error) throw new Error(`repeat check failed: ${r.error.message}`);
  const others = ((r.data ?? []) as (EntryRow & { id: string; created_at: string })[]).filter((x) => x.id !== mine.id);
  if (others.length === 0) return null;
  const docIds = others.map((x) => x.document_id).filter((x): x is string => !!x);
  const open = new Set<string>();
  if (docIds.length > 0) {
    const d = await env.admin.from("sign_documents").select("id, status").eq("account_id", form.account_id).in("id", docIds);
    if (d.error) throw new Error(`repeat check failed: ${d.error.message}`);
    for (const doc of (d.data ?? []) as { id: string; status: string }[]) if (OPEN.includes(doc.status)) open.add(doc.id);
  }
  const claimCutoff = env.now().getTime() - CLAIM_MS;
  for (const x of others) {
    const stands =
      (x.status === "accepted" && x.reason === null && (!form.send_document || !x.document_id || open.has(x.document_id))) ||
      (x.status === "failed" && (x.reason === "delivery_failed" || x.reason === "send_failed") && !!x.document_id && open.has(x.document_id)) ||
      (x.reason === "in_progress" && new Date(x.created_at).getTime() >= claimCutoff && (x.created_at < mine.created_at || (x.created_at === mine.created_at && x.id < mine.id)));
    if (stands) return { contact_id: x.contact_id ?? null, document_id: x.document_id ?? null };
  }
  return null;
}

// ---- sending the document ------------------------------------------------------------------------------

type SendResult = { ok: true; documentId: string } | { ok: false; reason: string; documentId: string | null };

/** What a failure to send is called in the record. */
function reasonOf(err: unknown): string {
  if (err instanceof SignError) {
    if (err.code === "sign_limit_reached") return "sign_limit_reached";
    if (err.code === "form_not_ready" || err.code === "not_ready") return "form_not_ready";
    if (err.code === "template_not_active" || err.code === "template_not_found" || err.code === "template_has_no_version") return "template_not_active";
  }
  return "send_failed";
}

async function sendToApplicant(ctx: SignCtx, form: RegistrationFormRow, who: Submission, contactId: string, locale: SignLocale): Promise<SendResult> {
  let draftId: string | null = null;
  try {
    const states = await loadTemplateStates(ctx, form.template_id ? [form.template_id] : []);
    const state = form.template_id ? (states.get(form.template_id) ?? null) : null;
    if (formReadiness(form, state).length > 0 || !state?.version || !form.template_id) throw new SignError("form_not_ready", "This form cannot send its document.", 409);
    const version = state.version;
    const role = version.roles.find((r) => r.key === form.applicant_role_key);
    if (!role) throw new SignError("form_not_ready", "This form cannot send its document.", 409);

    const title = `${state.name}: ${who.company ?? who.fullName ?? who.email}`.slice(0, 200);
    const draft = await createDraftFromTemplate(ctx, { templateId: form.template_id, contactId, title });
    draftId = draft.id;
    await updateDraft(ctx, draft.id, { locale, mergeValues: mergeValuesFor(version.fields, who) });
    // the person who set the form up owns what it makes: it is on their list, and the "finished" notice reaches them
    if (form.created_by) await ctx.admin.from("sign_documents").update({ created_by: form.created_by }).eq("id", draft.id).eq("account_id", ctx.accountId).eq("status", "draft");

    const applicant = { roleKey: role.key, kind: role.kind, fullName: (who.fullName ?? who.company ?? who.email).slice(0, 160), email: who.email, phone: who.phone ? `+${who.phone}` : null, channel: "email" as const, orderNo: 1 };
    const others = form.signers_other.map((s, i) => {
      const r = version.roles.find((x) => x.key === s.role_key);
      return { roleKey: s.role_key, kind: r?.kind ?? ("signer" as const), fullName: s.name, email: s.email, phone: s.phone ?? null, channel: s.channel, orderNo: i + 2 };
    });
    await setSigners(ctx, draft.id, [applicant, ...others]);

    const sent = await sendDocument(ctx, draft.id);
    const mine = sent.invited.find((i) => i.roleKey === role.key);
    if (!mine || mine.delivery.status !== "sent") return { ok: false, reason: "delivery_failed", documentId: draft.id };
    return { ok: true, documentId: draft.id };
  } catch (err) {
    if (!(err instanceof SignError)) console.error("[sign] a registration could not send its document:", err instanceof Error ? err.message : err);
    // an unsent draft is removed; one that was sent stays (and is what the record points at)
    let kept: string | null = null;
    if (draftId) {
      try {
        await deleteDraft(ctx, draftId);
      } catch {
        kept = draftId;
      }
    }
    return { ok: false, reason: reasonOf(err), documentId: kept };
  }
}

// ---- the whole submission --------------------------------------------------------------------------------

export async function submitRegistration(env: SubmitEnv, req: SubmitRequest): Promise<SubmitOutcome> {
  const found = await loadPublicForm(env.admin, req.slug, env.origin);
  if (!found) return { kind: "not_found" };
  const { form, workspace } = found;
  // no key to sign the page's token with, or no public address of our own to put on the emailed link: the page cannot be taken
  if (!registrationConfigured() || !env.origin) return { kind: "not_configured" };

  const now = env.now();
  const ipHash = hashIp(req.ip);
  const ua = (req.userAgent ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) || null;
  const base = { ip_hash: ipHash, user_agent: ua };

  // 1. how often: every post counts here, valid or not
  const { signRegisterIpAttempts, signRegisterFormAttempts, signRegisterIp, signRegisterForm, signRegisterEmail } = RATE_LIMITS;
  if (ipHash && !(await env.limit(`sign-reg:att:ip:${shortHash(ipHash)}`, signRegisterIpAttempts.limit, signRegisterIpAttempts.windowMs))) return { kind: "rate_limited" };
  if (!(await env.limit(`sign-reg:att:form:${form.id}`, signRegisterFormAttempts.limit, signRegisterFormAttempts.windowMs))) return { kind: "rate_limited" };

  const fresh = (): string => issueFormToken(form.id, env.now()) ?? "";
  const spam = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await insertEntry(env.admin, form.account_id, form.id, { ...base, ...extra }, { status: "rejected_spam", reason });
  };

  // 2. a script is judged before anything is looked at: the hidden field, then the token
  const trap = peekTrap(req.body);
  if (trap.honeypot) {
    await spam("honeypot");
    return { kind: "ok" }; // answered like a success, so a script learns nothing
  }
  const token = readFormToken(trap.token, form.id, now);
  if (!token.ok) {
    await spam(token.reason);
    return { kind: "retry", code: token.reason, token: fresh() };
  }

  // 3. the details
  const checked = parseSubmission(req.body, form.fields);
  if (!checked.ok) return { kind: "invalid", problems: checked.problems };
  const who = checked.value;
  const emailHash = hashEmail(who.email);
  const locale: SignLocale = who.locale ?? form.default_locale;
  const consentVersion = registrationConsentFor(form.consent_text, locale, workspace.name).version;
  const entryBase = { ...base, email_hash: emailHash, locale, consent_version: consentVersion };

  // 4. the details are valid: now the checks that cost something
  if (isTooFast(token.ageMs)) {
    await spam("token_too_fast", entryBase);
    return { kind: "retry", code: "token_too_fast", token: fresh() };
  }
  if (env.captcha.enabled && !(await env.captcha.verify(who.captcha, req.ip === "unknown" ? null : req.ip))) {
    await spam("captcha_failed", entryBase);
    return { kind: "retry", code: "captcha_failed", token: fresh() };
  }
  if (ipHash && !(await env.limit(`sign-reg:sub:ip:${shortHash(ipHash)}`, signRegisterIp.limit, signRegisterIp.windowMs))) return { kind: "rate_limited" };
  if (!(await env.limit(`sign-reg:sub:form:${form.id}`, signRegisterForm.limit, signRegisterForm.windowMs))) return { kind: "rate_limited" };
  // one address cannot be mailed from many pages: the budget follows the (hashed) email, not the form, so it holds across every form and workspace
  if (emailHash && !(await env.limit(`sign-reg:sub:email:${shortHash(emailHash)}`, signRegisterEmail.limit, signRegisterEmail.windowMs))) return { kind: "rate_limited" };

  // 5. claim the submission, then decide what it is
  const claim = await insertEntry(env.admin, form.account_id, form.id, entryBase, { status: "failed", reason: "in_progress" });
  if (!claim) return { kind: "failed", saved: false };
  const settle = (patch: Partial<EntryRow> & { status: RegistrationStatus }) => settleEntry(env.admin, form.account_id, claim.id, patch);

  let saved = false;
  try {
    const prior = await findPrior(env, form, claim, emailHash ?? "");
    if (prior) {
      await settle({ status: "accepted", reason: "duplicate", contact_id: prior.contact_id, document_id: prior.document_id });
      return { kind: "ok" };
    }

    // what the cap counts: acceptances that started something, in the last 24 hours (a repeat started nothing)
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const today = await env.admin.from("sign_registrations").select("id", { count: "exact", head: true }).eq("account_id", form.account_id).eq("form_id", form.id).eq("status", "accepted").is("reason", null).gte("created_at", since);
    if (today.error) throw new Error(`cap check failed: ${today.error.message}`);
    // Requests that are being handled at this very moment have not been settled yet, so the count above does not see them: several posts
    // arriving together would all read "one place left". Every claim that began before this one (the same order the repeat check uses) counts,
    // so at most the places that are left get through, however many arrive at once.
    const inflight = await env.admin.from("sign_registrations").select("id, created_at").eq("account_id", form.account_id).eq("form_id", form.id).eq("reason", "in_progress").gte("created_at", new Date(now.getTime() - CLAIM_MS).toISOString()).limit(1000);
    if (inflight.error) throw new Error(`cap check failed: ${inflight.error.message}`);
    const ahead = ((inflight.data ?? []) as { id: string; created_at: string }[]).filter((x) => x.id !== claim.id && (x.created_at < claim.created_at || (x.created_at === claim.created_at && x.id < claim.id))).length;
    if ((today.count ?? 0) + ahead >= form.daily_cap) {
      await settle({ status: "rejected_cap", reason: "daily_cap" });
      return { kind: "cap" };
    }

    let contactId: string;
    try {
      contactId = (await upsertApplicantContact(env.admin, form.account_id, { fullName: who.fullName, email: who.email, phone: who.phone, company: who.company })).id;
    } catch (err) {
      const limitReached = err instanceof UsageLimitError;
      console.error("[sign] a registration could not make its contact:", err instanceof Error ? err.message : err);
      await settle({ status: "failed", reason: limitReached ? "contact_limit_reached" : "send_failed" });
      return { kind: "failed", saved: false };
    }
    saved = true;

    if (form.contact_tag_id) {
      try {
        await addContactTagAndDispatch({ db: env.admin, accountId: form.account_id, contactId, tagId: form.contact_tag_id });
      } catch (err) {
        // a tag that is gone or not approved must not stop the registration
        console.error("[sign] a registration could not tag its contact:", err instanceof Error ? err.message : err);
      }
    }

    if (!form.send_document) {
      await settle({ status: "accepted", reason: null, contact_id: contactId });
      return { kind: "ok" };
    }

    const ctx = systemCtx(env.admin, form.account_id, env.origin, env.deps, env.now);
    const sent = await sendToApplicant(ctx, form, who, contactId, locale);
    if (!sent.ok) {
      await settle({ status: "failed", reason: sent.reason, contact_id: contactId, document_id: sent.documentId });
      return { kind: "failed", saved };
    }
    await settle({ status: "accepted", reason: null, contact_id: contactId, document_id: sent.documentId });
    return { kind: "ok" };
  } catch (err) {
    console.error("[sign] a registration failed:", err instanceof Error ? err.message : err);
    await settle({ status: "failed", reason: "send_failed" });
    return { kind: "failed", saved };
  }
}
