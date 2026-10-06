// ============================================================
// Doc Sign bulk send: the setup of a batch (which role the people of the list fill, who fills the others, what
// every document shares) and what one document of the batch looks like. Pure, shared by the preview, the creation
// and the runner, so a person is judged the same way at each.
// ============================================================

import { cleanReminderDays } from "../defaults";
// not the forms barrel: it re-exports printing, which pulls the PDF engine (and its font files) into the browser bundle of the bulk page
import type { FormDefinition } from "../forms/types";
import { formSendProblems, validateForm } from "../forms/validate";
import type { PlacedField } from "../pdf/types";
import { normalizePhone, sendProblems, type Issue } from "../rules";
import type { SignChannel, SignMode, SignRole, SignerKind } from "../types";
import { SIGN_LOCALES } from "../types";
import { isPersonKey } from "./parse";
import { BULK_MAX_FIXED, type BulkFixedSigner, type BulkOptions, type BulkProblem, type BulkRoleInfo } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** A person of a document, in the shape `setSigners` takes. */
export interface PlannedSigner {
  roleKey: string;
  kind: SignerKind;
  fullName: string;
  email: string;
  phone: string | null;
  channel: SignChannel;
  orderNo: number;
  internalUserId: null;
}

/**
 * The people of one document: the person of the list in `options.personRole`, and the fixed person of each
 * other role the sender named. Ordered by the template's roles, which also gives the signing order.
 */
export function buildSigners(person: { name: string; email: string; phone: string | null }, options: BulkOptions, roles: readonly SignRole[]): PlannedSigner[] {
  const fixed = new Map(options.fixedSigners.map((f) => [f.roleKey, f]));
  const out: PlannedSigner[] = [];
  roles.forEach((role, i) => {
    if (role.key === options.personRole) {
      out.push({ roleKey: role.key, kind: role.kind, fullName: person.name, email: person.email, phone: person.phone, channel: options.channel, orderNo: i + 1, internalUserId: null });
      return;
    }
    const f = fixed.get(role.key);
    if (f) out.push({ roleKey: role.key, kind: role.kind, fullName: f.fullName.trim(), email: f.email.trim(), phone: f.channel === "whatsapp" ? normalizePhone(f.phone) : f.phone?.trim() || null, channel: f.channel, orderNo: i + 1, internalUserId: null });
  });
  return out;
}

/** The template's roles as the screen shows them, with the ones that have fields to complete flagged. */
export function roleInfos(roles: readonly SignRole[], fields: readonly PlacedField[]): BulkRoleInfo[] {
  return roles.map((r) => ({
    key: r.key,
    label: r.label,
    kind: r.kind,
    needsPerson: fields.some((f) => f.role === r.key && f.type !== "static_text" && !f.merge && !f.data && f.type !== "date_signed" && f.type !== "name"),
  }));
}

/** Codes `sendProblems` gives about one particular person; the batch judges each person itself. */
const PER_PERSON_CODES = new Set(["signer_name", "signer_email", "signer_phone", "signer_role", "signer_order", "order_not_unique", "same_person_twice"]);

export interface PlanInput {
  roles: readonly SignRole[];
  fields: readonly PlacedField[];
  form: FormDefinition | null;
  pageCount: number;
  options: BulkOptions;
  /** What the documents will use for signing order: the sender's choice, else the template's default. */
  signInOrder: boolean;
  /** A form without a signature (migration 169): nobody signs, so nobody needs a signature place. Absent is an agreement to sign. */
  mode?: SignMode;
}

/** Problems with the setup as a whole, found once: the template cannot be sent with these people, whoever is on the list. */
export function planProblems(input: PlanInput): BulkProblem[] {
  const { roles, fields, form, options } = input;
  const out: BulkProblem[] = [];
  const add = (p: BulkProblem) => {
    if (!out.some((x) => x.code === p.code && x.detail === p.detail)) out.push(p);
  };
  const roleKeys = new Set(roles.map((r) => r.key));
  if (!roleKeys.has(options.personRole)) add({ code: "bad_person_role" });
  if (options.fixedSigners.length > BULK_MAX_FIXED) add({ code: "bad_options", detail: "fixed_signers" });
  const seen = new Set<string>();
  for (const f of options.fixedSigners) {
    if (!roleKeys.has(f.roleKey) || f.roleKey === options.personRole || seen.has(f.roleKey)) {
      add({ code: "bad_fixed_signer", detail: f.roleKey });
      continue;
    }
    seen.add(f.roleKey);
    if (!f.fullName.trim() || f.fullName.trim().length > 160) add({ code: "fixed_signer_name", detail: f.roleKey });
    if (!EMAIL_RE.test(f.email.trim()) || f.email.trim().length > 254) add({ code: "fixed_signer_email", detail: f.roleKey });
    if (f.channel === "whatsapp" && !normalizePhone(f.phone)) add({ code: "fixed_signer_phone", detail: f.roleKey });
  }
  if (out.length > 0) return out;

  // the template, with a stand-in for the person of the list: the same checks a single send makes
  const sample = { name: "Sample Person", email: "bulk-sample@example.invalid", phone: options.channel === "whatsapp" ? "+60123456789" : null };
  const signers = buildSigners(sample, options, roles);
  const found: Issue[] = sendProblems({
    fields: [...fields],
    roles: [...roles],
    signers: signers.map((s) => ({ role_key: s.roleKey, kind: s.kind, full_name: s.fullName, email: s.email, phone: s.phone, channel: s.channel, order_no: s.orderNo })),
    signInOrder: input.signInOrder,
    pageCount: input.pageCount,
    hasBaseFile: true,
    mode: input.mode,
  });
  if (form) found.push(...validateForm(form, [...roles], [...fields]), ...formSendProblems(form, signers.map((s) => ({ role_key: s.roleKey }))));
  else if (fields.some((f) => f.data !== undefined)) found.push(...validateForm({ version: 1, parts: [], fields: [] }, [...roles], [...fields]));
  for (const i of found) {
    if (PER_PERSON_CODES.has(i.code)) continue;
    if (i.code === "role_without_person" || i.code === "part_without_person") add({ code: "role_without_person", detail: i.role });
    else if (i.code === "signer_without_signature") add({ code: "signer_without_signature", detail: i.role });
    else add({ code: "template_not_ready", detail: i.code });
  }
  return out;
}

/** The template's merge keys the file cannot be expected to carry when the people come from contacts: only a column can supply them. */
export function keysNeedingColumns(mergeKeys: readonly string[]): string[] {
  return mergeKeys.filter((k) => !isPersonKey(k));
}

/** The title of one document: the sender's pattern with `{name}` filled in, or "<template title> - <name>". At most 200 characters. */
export function titleFor(pattern: string | null, templateTitle: string, name: string): string {
  const base = pattern?.trim() ? pattern.replace(/\{name\}/gi, name) : `${templateTitle} - ${name}`;
  return base.trim().slice(0, 200).trim() || templateTitle.slice(0, 200);
}

/** When a document sent `now` stops accepting signatures, `days` days on. */
export const expiryIso = (now: Date, days: number): string => new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString();

// ---- the options as a browser sends them ---------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null | undefined => (v === null || v === undefined || v === "" ? null : typeof v === "string" && v.trim().length <= max ? v.trim() : undefined);

/** Read and check the options. Anything that is not right is a problem; nothing is guessed. */
export function parseOptions(raw: unknown): { options: BulkOptions | null; problems: BulkProblem[] } {
  const problems: BulkProblem[] = [];
  const bad = (detail: string) => problems.push({ code: "bad_options", detail });
  if (!isObject(raw)) return { options: null, problems: [{ code: "bad_options" }] };

  const templateId = typeof raw.templateId === "string" && UUID_RE.test(raw.templateId) ? raw.templateId : null;
  if (!templateId) bad("templateId");
  const personRole = typeof raw.personRole === "string" && ROLE_RE.test(raw.personRole) ? raw.personRole : null;
  if (!personRole) bad("personRole");
  const channel: SignChannel | null = raw.channel === "email" || raw.channel === "whatsapp" ? raw.channel : null;
  if (!channel) bad("channel");

  const fixedSigners: BulkFixedSigner[] = [];
  if (raw.fixedSigners !== undefined && raw.fixedSigners !== null) {
    if (!Array.isArray(raw.fixedSigners) || raw.fixedSigners.length > BULK_MAX_FIXED) bad("fixedSigners");
    else {
      for (const f of raw.fixedSigners) {
        if (!isObject(f) || typeof f.roleKey !== "string" || !ROLE_RE.test(f.roleKey) || typeof f.fullName !== "string" || typeof f.email !== "string" || (f.channel !== "email" && f.channel !== "whatsapp")) {
          bad("fixedSigners");
          break;
        }
        fixedSigners.push({ roleKey: f.roleKey, fullName: f.fullName.slice(0, 200), email: f.email.slice(0, 300), phone: typeof f.phone === "string" ? f.phone.slice(0, 40) : null, channel: f.channel });
      }
    }
  }

  const title = text(raw.title, 200);
  if (title === undefined) bad("title");
  const message = text(raw.message, 2000);
  if (message === undefined) bad("message");
  const categoryId = raw.categoryId === null || raw.categoryId === undefined || raw.categoryId === "" ? null : typeof raw.categoryId === "string" && UUID_RE.test(raw.categoryId) ? raw.categoryId : undefined;
  if (categoryId === undefined) bad("categoryId");
  const locale = raw.locale === null || raw.locale === undefined || raw.locale === "" ? null : SIGN_LOCALES.includes(raw.locale as never) ? (raw.locale as BulkOptions["locale"]) : undefined;
  if (locale === undefined) bad("locale");
  const expiryDays = raw.expiryDays === null || raw.expiryDays === undefined ? null : Number.isInteger(raw.expiryDays) && (raw.expiryDays as number) >= 1 && (raw.expiryDays as number) <= 365 ? (raw.expiryDays as number) : undefined;
  if (expiryDays === undefined) bad("expiryDays");
  const flag = (v: unknown): boolean | null | undefined => (v === null || v === undefined ? null : typeof v === "boolean" ? v : undefined);
  const codeRequired = flag(raw.codeRequired);
  if (codeRequired === undefined) bad("codeRequired");
  const signInOrder = flag(raw.signInOrder);
  if (signInOrder === undefined) bad("signInOrder");
  let reminderDays: number[] | null = null;
  if (raw.reminderDays !== null && raw.reminderDays !== undefined) {
    if (!Array.isArray(raw.reminderDays) || raw.reminderDays.some((d) => typeof d !== "number")) bad("reminderDays");
    else reminderDays = cleanReminderDays(raw.reminderDays as number[]);
  }

  if (problems.length > 0 || !templateId || !personRole || !channel) return { options: null, problems };
  return {
    options: {
      templateId,
      personRole,
      fixedSigners,
      channel,
      title: title ?? null,
      categoryId: categoryId ?? null,
      message: message ?? null,
      locale: locale ?? null,
      expiryDays: expiryDays ?? null,
      codeRequired: codeRequired ?? null,
      signInOrder: signInOrder ?? null,
      reminderDays,
    },
    problems,
  };
}
