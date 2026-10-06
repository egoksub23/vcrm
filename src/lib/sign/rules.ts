// ============================================================
// The rules of a document, in one place used by the browser (so a sender sees a problem as they
// type) and by the server (which never trusts the browser). Pure: no I/O, no framework.
//
//   validateFields / validateRoles   is the layout of a template or document sound?
//   checkAnswer                      is one entered value acceptable for its field, and what is stored?
//   missingRequired                  what has a signer not yet completed?
//   sendProblems                     can this document be sent?
// ============================================================

import type { FormDefinition } from "./forms/types";
import { FIELD_TYPES, type FieldType, type PlacedField } from "./pdf/types";
import type { SignChannel, SignMode, SignRole, SignerKind } from "./types";

export const MAX_FIELDS = 300;
export const MAX_ROLES = 6;
export const MAX_SIGNERS = 20;
export const MAX_TEXT = 2000;
export const MAX_SINGLE_LINE = 200;
export const MAX_IMAGE_BYTES = 400 * 1024;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** The same pattern for the code outside this file that names a role (registration forms). */
export const KEY_PATTERN = KEY_RE;
const DATE_FORMAT_RE = /^(?:YYYY|YY|MMMM|MMM|MM|M|DD|D|[ /.,\-])+$/;
/** The role that owns fields the sender fixes (static text and merge fields). */
export const SENDER_ROLE = "sender";

/** Field types a person fills in. The rest are written by the sender or by the engine (the signer's name and the signing date). */
export const ANSWERED_TYPES: readonly FieldType[] = ["signature", "initials", "date", "text", "number", "checkbox", "dropdown", "upload"];
/** Field types only a signer (not a filler) may own: they are the act of signing. */
export const SIGNER_ONLY_TYPES: readonly FieldType[] = ["signature", "initials", "date_signed"];

export interface Issue {
  /** A stable code for the screen to word; `field` or `role` says where. */
  code: string;
  field?: string;
  role?: string;
  /** Forms: the part it is about. */
  part?: string;
  /** Envelopes (migration 171): the document of the envelope it is about. */
  document?: string;
  detail?: string;
}

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function validateRoles(roles: readonly SignRole[]): Issue[] {
  const issues: Issue[] = [];
  if (roles.length > MAX_ROLES) issues.push({ code: "too_many_roles", detail: String(MAX_ROLES) });
  const seen = new Set<string>();
  for (const r of roles) {
    if (!KEY_RE.test(r.key) || r.key === SENDER_ROLE) issues.push({ code: "bad_role_key", role: r.key });
    if (seen.has(r.key)) issues.push({ code: "duplicate_role", role: r.key });
    seen.add(r.key);
    if (!r.label || r.label.trim().length === 0 || r.label.length > 60) issues.push({ code: "bad_role_label", role: r.key });
    if (r.kind !== "signer" && r.kind !== "filler") issues.push({ code: "bad_role_kind", role: r.key });
  }
  return issues;
}

/** Is the layout of `fields` sound for a document of `pageCount` pages and these roles? */
export function validateFields(fields: readonly PlacedField[], roles: readonly SignRole[], pageCount: number): Issue[] {
  const issues: Issue[] = [];
  if (fields.length > MAX_FIELDS) issues.push({ code: "too_many_fields", detail: String(MAX_FIELDS) });
  const roleByKey = new Map(roles.map((r) => [r.key, r]));
  const keys = new Set<string>();
  for (const f of fields) {
    const at = { field: f.key };
    if (!KEY_RE.test(f.key)) issues.push({ code: "bad_field_key", ...at });
    if (keys.has(f.key)) issues.push({ code: "duplicate_field_key", ...at });
    keys.add(f.key);
    if (!FIELD_TYPES.includes(f.type)) {
      issues.push({ code: "bad_field_type", ...at });
      continue;
    }
    // a field the sender fixes (static text, a merge value) or that prints an answer to the form belongs to no one who answers
    const senderFixed = f.type === "static_text" || !!f.merge || !!f.data;
    if (senderFixed) {
      if (f.role !== SENDER_ROLE && !roleByKey.has(f.role)) issues.push({ code: "unknown_role", ...at, role: f.role });
    } else {
      const role = roleByKey.get(f.role);
      if (!role) issues.push({ code: "unknown_role", ...at, role: f.role });
      else if (SIGNER_ONLY_TYPES.includes(f.type) && role.kind !== "signer") issues.push({ code: "filler_cannot_sign", ...at, role: f.role });
    }
    if (!Number.isInteger(f.page) || f.page < 0 || f.page >= pageCount) issues.push({ code: "page_out_of_range", ...at });
    const geometryOk = [f.x, f.y, f.w, f.h].every(isFiniteNumber);
    if (!geometryOk || f.x < 0 || f.y < 0 || f.w <= 0 || f.h <= 0 || f.x + f.w > 1.0001 || f.y + f.h > 1.0001) {
      issues.push({ code: "outside_page", ...at });
    } else if (f.w < 0.005 || f.h < 0.003) {
      issues.push({ code: "too_small", ...at });
    }
    if (f.type === "dropdown") {
      const o = f.options ?? [];
      if (o.length === 0 || o.length > 50 || o.some((x) => typeof x !== "string" || x.length === 0 || x.length > 100) || new Set(o).size !== o.length) {
        issues.push({ code: "bad_options", ...at });
      }
    }
    if ((f.type === "date" || f.type === "date_signed") && f.dateFormat !== undefined && (!DATE_FORMAT_RE.test(f.dateFormat) || f.dateFormat.length > 30)) {
      issues.push({ code: "bad_date_format", ...at });
    }
    if (f.type === "number" && f.decimals !== undefined && (!Number.isInteger(f.decimals) || f.decimals < 0 || f.decimals > 6)) {
      issues.push({ code: "bad_decimals", ...at });
    }
    if (f.type === "static_text" && !f.merge && (!f.text || f.text.length > MAX_TEXT)) issues.push({ code: "bad_static_text", ...at });
    if (f.merge !== undefined && !KEY_RE.test(f.merge)) issues.push({ code: "bad_merge_key", ...at });
    if (f.fontSize !== undefined && (!isFiniteNumber(f.fontSize) || f.fontSize < 5 || f.fontSize > 32)) issues.push({ code: "bad_font_size", ...at });
    if (f.label !== undefined && f.label.length > 100) issues.push({ code: "bad_label", ...at });
  }
  return issues;
}

// ---- answers ------------------------------------------------------------------

/** What a browser sends for one field. Which members matter depends on the field type. */
export interface AnswerInput {
  text?: unknown;
  checked?: unknown;
  /** A drawn or uploaded signature or image, as a data URL (PNG or JPEG). */
  image?: unknown;
  /** A typed signature or initials. */
  typed?: unknown;
}

/** What is stored for one answer (the `value` column of sign_answers). */
export type StoredAnswer =
  | { text: string }
  | { checked: boolean }
  | { image: string; mime: "image/png" | "image/jpeg" }
  | { typed: string };

export type AnswerResult = { ok: true; value: StoredAnswer | null } | { ok: false; code: string };

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanText(v: unknown, max: number, multiline: boolean): string | null {
  if (typeof v !== "string") return null;
  let s = v.normalize("NFC").replace(CONTROL_RE, "");
  if (!multiline) s = s.replace(/[\r\n\t]+/g, " ");
  s = s.trim();
  return s.length <= max ? s : null;
}

function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Decode `data:image/png;base64,...` and check the bytes really are that image. */
export function decodeImageDataUrl(v: unknown): { mime: "image/png" | "image/jpeg"; bytes: Uint8Array } | null {
  if (typeof v !== "string") return null;
  const m = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (!m) return null;
  if (m[2].length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) return null;
  const bytes = Uint8Array.from(Buffer.from(m[2], "base64"));
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (m[1] === "image/png" ? !png : !jpg) return null;
  return { mime: m[1] as "image/png" | "image/jpeg", bytes };
}

/**
 * Check one entered value against its field. An empty value is `{ ok: true, value: null }`: the field
 * is simply not answered (whether that is allowed is `missingRequired`'s question).
 */
export function checkAnswer(field: PlacedField, input: AnswerInput | undefined): AnswerResult {
  if (!input) return { ok: true, value: null };
  switch (field.type) {
    case "text":
    case "name": {
      if (input.text === undefined || input.text === null || input.text === "") return { ok: true, value: null };
      const max = field.type === "name" ? 160 : field.multiline ? MAX_TEXT : MAX_SINGLE_LINE;
      const t = cleanText(input.text, max, !!field.multiline && field.type === "text");
      if (t === null) return { ok: false, code: "text_too_long" };
      return { ok: true, value: t === "" ? null : { text: t } };
    }
    case "number": {
      if (input.text === undefined || input.text === null || input.text === "") return { ok: true, value: null };
      if (typeof input.text !== "string") return { ok: false, code: "not_a_number" };
      const n = input.text.replace(/[,\s]/g, "");
      if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(n)) return { ok: false, code: "not_a_number" };
      return { ok: true, value: { text: n } };
    }
    case "date": {
      if (input.text === undefined || input.text === null || input.text === "") return { ok: true, value: null };
      if (typeof input.text !== "string" || !isRealDate(input.text)) return { ok: false, code: "not_a_date" };
      return { ok: true, value: { text: input.text } };
    }
    case "dropdown": {
      if (input.text === undefined || input.text === null || input.text === "") return { ok: true, value: null };
      if (typeof input.text !== "string" || !(field.options ?? []).includes(input.text)) return { ok: false, code: "not_an_option" };
      return { ok: true, value: { text: input.text } };
    }
    case "checkbox": {
      if (input.checked === undefined || input.checked === null) return { ok: true, value: null };
      if (typeof input.checked !== "boolean") return { ok: false, code: "not_a_checkbox" };
      return { ok: true, value: { checked: input.checked } };
    }
    case "signature":
    case "initials": {
      const hasImage = input.image !== undefined && input.image !== null && input.image !== "";
      const hasTyped = input.typed !== undefined && input.typed !== null && input.typed !== "";
      if (!hasImage && !hasTyped) return { ok: true, value: null };
      if (hasImage) {
        const img = decodeImageDataUrl(input.image);
        if (!img) return { ok: false, code: "bad_image" };
        return { ok: true, value: { image: input.image as string, mime: img.mime } };
      }
      const t = cleanText(input.typed, field.type === "initials" ? 10 : 100, false);
      if (t === null || t === "") return { ok: false, code: "bad_typed_signature" };
      return { ok: true, value: { typed: t } };
    }
    case "upload": {
      // a picture entered in the field; other files are attached through the upload route
      if (input.image === undefined || input.image === null || input.image === "") return { ok: true, value: null };
      const img = decodeImageDataUrl(input.image);
      if (!img) return { ok: false, code: "bad_image" };
      return { ok: true, value: { image: input.image as string, mime: img.mime } };
    }
    default:
      // date_signed and static_text are not entered by anyone
      return { ok: true, value: null };
  }
}

/** The fields a role completes (not static, and not written by the engine: the signer's name and the signing date). */
export function fieldsForRole(fields: readonly PlacedField[], roleKey: string): PlacedField[] {
  return fields.filter((f) => f.role === roleKey && f.type !== "static_text" && !f.merge && !f.data && f.type !== "date_signed" && f.type !== "name");
}

/** Required fields of a role that have no answer yet. `answered` is the set of field keys with a stored value. */
export function missingRequired(fields: readonly PlacedField[], roleKey: string, answered: ReadonlySet<string>): PlacedField[] {
  return fieldsForRole(fields, roleKey).filter((f) => f.required && !answered.has(f.key));
}

// ---- readiness to send ----------------------------------------------------------

export interface SignerDraft {
  role_key: string;
  kind: SignerKind;
  full_name: string;
  email: string;
  phone?: string | null;
  channel: SignChannel;
  order_no: number;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** International number: + and 8 to 15 digits, spaces and dashes allowed in the input. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[\s\-().]/g, "");
  return /^\+\d{8,15}$/.test(digits) ? digits : null;
}

/**
 * Everything standing between a draft and "Send": a list of problems, empty when it can go.
 * `signInOrder` is the document's "needs signing order" choice. With it, people who share an order number form
 * one step: all of them are invited together and the next step begins when every one of them has finished.
 */
export function sendProblems(args: {
  fields: readonly PlacedField[];
  roles: readonly SignRole[];
  signers: readonly SignerDraft[];
  signInOrder: boolean;
  pageCount: number;
  hasBaseFile: boolean;
  /** A form without a signature (migration 169): nobody signs, so nobody is a signer and nothing is a signature. Default `sign`. */
  mode?: SignMode;
}): Issue[] {
  const { fields, roles, signers, signInOrder } = args;
  const formOnly = args.mode === "form";
  const issues: Issue[] = [];
  if (!args.hasBaseFile) issues.push({ code: "no_file" });
  issues.push(...validateRoles(roles), ...validateFields(fields, roles, args.pageCount), ...modeProblems(args.mode, { roles, fields }));

  // an agreement needs a signer; a form needs somebody to fill it in
  if (signers.length === 0 || (!formOnly && !signers.some((s) => s.kind === "signer"))) issues.push({ code: formOnly ? "no_person" : "no_signer" });
  if (signers.length > MAX_SIGNERS) issues.push({ code: "too_many_signers", detail: String(MAX_SIGNERS) });
  const roleKeys = new Set(roles.map((r) => r.key));
  const rolesWithPeople = new Set(signers.map((s) => s.role_key));
  signers.forEach((s, i) => {
    const at = { detail: String(i) };
    if (!s.full_name || s.full_name.trim().length === 0 || s.full_name.length > 160) issues.push({ code: "signer_name", ...at });
    if (!EMAIL_RE.test(s.email) || s.email.length > 254) issues.push({ code: "signer_email", ...at });
    if (s.channel === "whatsapp" && !normalizePhone(s.phone)) issues.push({ code: "signer_phone", ...at });
    if (roles.length > 0 && !roleKeys.has(s.role_key)) issues.push({ code: "signer_role", ...at, role: s.role_key });
    if (!Number.isInteger(s.order_no) || s.order_no < 1) issues.push({ code: "signer_order", ...at });
  });
  // a role with fields to complete needs a person
  for (const r of roles) {
    if (fieldsForRole(fields, r.key).length > 0 && !rolesWithPeople.has(r.key)) issues.push({ code: "role_without_person", role: r.key });
  }
  // a signer needs something to sign
  for (const s of formOnly ? [] : signers) {
    if (s.kind === "signer" && !fields.some((f) => f.role === s.role_key && (f.type === "signature" || f.type === "initials"))) {
      issues.push({ code: "signer_without_signature", role: s.role_key });
      break;
    }
  }
  if (signInOrder) {
    // People who share an order number form one step and sign at the same time (F-68), so a shared number is no
    // problem; the same person on the list twice still is (they would be asked for two signatures at once or in turn).
    const emails = signers.map((s) => s.email.trim().toLowerCase());
    if (new Set(emails).size !== emails.length) issues.push({ code: "same_person_twice" });
  }
  return issues;
}

// ---- a form without a signature (migration 169) -----------------------------------------

/**
 * What a form-only document (mode `form`) may not be: it has no signer, so no role that signs, and nothing on the page to
 * sign or to fill (the answers are asked by the form, in parts, and recorded in the submission record, not placed on a page).
 * `requireParts`: the form must have at least one part (when a template is made active, and when a document is sent: a
 * template is saved empty first). A document of mode `sign` has nothing here; its rules are unchanged.
 */
export function modeProblems(mode: SignMode | undefined, input: { roles: readonly SignRole[]; fields: readonly PlacedField[]; form?: FormDefinition | null }, opts: { requireParts?: boolean } = {}): Issue[] {
  if (mode !== "form") return [];
  const issues: Issue[] = [];
  for (const r of input.roles) if (r.kind !== "filler") issues.push({ code: "form_mode_signer_role", role: r.key });
  for (const f of input.fields) {
    if (SIGNER_ONLY_TYPES.includes(f.type)) issues.push({ code: "form_mode_signature", field: f.key });
    else issues.push({ code: "form_mode_placement", field: f.key });
  }
  if (opts.requireParts && !(input.form && input.form.parts.length > 0)) issues.push({ code: "form_mode_needs_a_form" });
  return issues;
}
