// ============================================================
// Is an entered value acceptable for its data field, and what is stored? One function for the browser
// (instant feedback) and the server (the authority). An empty value is `{ ok: true, value: null }`: the
// field is simply not answered; whether it must be is `completion.ts`'s question.
//
// Text shapes are fixed presets (digits, letters, a Malaysian postcode ...), never free regular
// expressions from a form author, so a form definition can never carry a pattern that hangs the server.
// ============================================================

import { decodeImageDataUrl } from "../rules";
import { MAX_SINGLE_LINE, MAX_TEXT } from "../rules";
import { type DataAnswerInput, type DataField, type FormValue, type TextFormat } from "./types";

export type CheckResult = { ok: true; value: FormValue | null } | { ok: false; code: string; detail?: string };

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(v: unknown, multiline: boolean): string | null {
  if (typeof v !== "string") return null;
  let s = v.normalize("NFC").replace(CONTROL_RE, "");
  if (!multiline) s = s.replace(/[\r\n\t]+/g, " ");
  return s.trim();
}

const FORMAT_RE: Record<Exclude<TextFormat, "any">, RegExp> = {
  digits: /^\d+$/,
  letters: /^[\p{L}\p{M} .'’\-/]+$/u,
  alnum: /^[\p{L}\p{N}\p{M}]+$/u,
  upper_alnum: /^[A-Z0-9]+$/,
  postcode_my: /^\d{5}$/,
};

/** Does `s` have the shape `format` asks for? */
export function matchesFormat(s: string, format: TextFormat | undefined): boolean {
  if (!format || format === "any") return true;
  return FORMAT_RE[format].test(s);
}

/** A phone number as stored: + and 8 to 15 digits. A leading 0 is Malaysian (+60); 60 without + is read as +60. */
export function normalizePhoneMy(raw: string): string | null {
  let d = raw.replace(/[\s\-().]/g, "");
  if (d.startsWith("00")) d = `+${d.slice(2)}`;
  if (d.startsWith("+")) return /^\+\d{8,15}$/.test(d) ? d : null;
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith("0")) d = `60${d.slice(1)}`;
  else if (!d.startsWith("60")) return null;
  return /^\d{9,15}$/.test(d) ? `+${d}` : null;
}

function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const strings = (v: unknown, max: number): string[] | null => {
  if (!Array.isArray(v) || v.length > max) return null;
  return v.every((x) => typeof x === "string") ? (v as string[]) : null;
};

export function checkDataAnswer(field: DataField, input: DataAnswerInput | undefined): CheckResult {
  if (!input) return { ok: true, value: null };
  const blank = (v: unknown) => v === undefined || v === null || v === "";

  switch (field.type) {
    case "text":
    case "multiline": {
      if (blank(input.text)) return { ok: true, value: null };
      const multi = field.type === "multiline";
      const t = clean(input.text, multi);
      if (t === null) return { ok: false, code: "bad_text" };
      if (t === "") return { ok: true, value: null };
      const max = Math.min(field.maxLength ?? (multi ? MAX_TEXT : MAX_SINGLE_LINE), multi ? MAX_TEXT : MAX_SINGLE_LINE);
      if (t.length > max) return { ok: false, code: "text_too_long", detail: String(max) };
      if (field.minLength && t.length < field.minLength) return { ok: false, code: "text_too_short", detail: String(field.minLength) };
      if (!matchesFormat(t, field.format)) return { ok: false, code: `format_${field.format}` };
      return { ok: true, value: { text: t } };
    }
    case "email": {
      if (blank(input.text)) return { ok: true, value: null };
      const t = clean(input.text, false);
      if (t === null || t === "") return { ok: true, value: null };
      if (t.length > 254 || !EMAIL_RE.test(t)) return { ok: false, code: "bad_email" };
      return { ok: true, value: { text: t.toLowerCase() } };
    }
    case "phone": {
      if (blank(input.text)) return { ok: true, value: null };
      if (typeof input.text !== "string") return { ok: false, code: "bad_phone" };
      if (input.text.trim() === "") return { ok: true, value: null };
      const p = normalizePhoneMy(input.text);
      return p ? { ok: true, value: { text: p } } : { ok: false, code: "bad_phone" };
    }
    case "number": {
      if (blank(input.text)) return { ok: true, value: null };
      if (typeof input.text !== "string") return { ok: false, code: "not_a_number" };
      const n = input.text.replace(/[,\s]/g, "");
      if (n === "") return { ok: true, value: null };
      if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(n)) return { ok: false, code: "not_a_number" };
      const decimals = field.decimals ?? 6;
      const frac = n.split(".")[1]?.length ?? 0;
      if (frac > decimals) return { ok: false, code: "too_many_decimals", detail: String(decimals) };
      const num = Number(n);
      if (field.min !== undefined && num < field.min) return { ok: false, code: "number_too_small", detail: String(field.min) };
      if (field.max !== undefined && num > field.max) return { ok: false, code: "number_too_big", detail: String(field.max) };
      return { ok: true, value: { text: n } };
    }
    case "date": {
      if (blank(input.text)) return { ok: true, value: null };
      if (typeof input.text !== "string" || !isRealDate(input.text)) return { ok: false, code: "not_a_date" };
      return { ok: true, value: { text: input.text } };
    }
    case "choice": {
      if (blank(input.text)) return { ok: true, value: null };
      if (typeof input.text !== "string" || !(field.options ?? []).some((o) => o.value === input.text)) return { ok: false, code: "not_an_option" };
      return { ok: true, value: { text: input.text } };
    }
    case "multichoice": {
      if (input.choices === undefined || input.choices === null) return { ok: true, value: null };
      const list = strings(input.choices, 100);
      if (!list) return { ok: false, code: "not_an_option" };
      const allowed = new Set((field.options ?? []).map((o) => o.value));
      if (list.some((c) => !allowed.has(c)) || new Set(list).size !== list.length) return { ok: false, code: "not_an_option" };
      return { ok: true, value: list.length ? { choices: list } : null };
    }
    case "yesno": {
      if (input.checked === undefined || input.checked === null) return { ok: true, value: null };
      if (typeof input.checked !== "boolean") return { ok: false, code: "not_yes_no" };
      return { ok: true, value: { checked: input.checked } };
    }
    case "acknowledge": {
      if (input.checked === undefined || input.checked === null) return { ok: true, value: null };
      if (typeof input.checked !== "boolean") return { ok: false, code: "not_yes_no" };
      // not accepting is not an answer
      return { ok: true, value: input.checked ? { checked: true } : null };
    }
    case "list": {
      if (input.list === undefined || input.list === null) return { ok: true, value: null };
      const raw = strings(input.list, 200);
      if (!raw) return { ok: false, code: "bad_item" };
      const maxItems = field.maxItems ?? 20;
      const items: string[] = [];
      for (const r of raw) {
        const t = clean(r, false);
        if (t === null) return { ok: false, code: "bad_item" };
        if (t === "") continue;
        if (t.length > (field.itemLength ?? 100)) return { ok: false, code: "item_too_long", detail: String(field.itemLength ?? 100) };
        if (!matchesFormat(t, field.itemFormat)) return { ok: false, code: `item_format_${field.itemFormat}` };
        items.push(t);
      }
      if (items.length > maxItems) return { ok: false, code: "too_many_items", detail: String(maxItems) };
      if (new Set(items).size !== items.length) return { ok: false, code: "duplicate_item" };
      if (field.minItems && items.length > 0 && items.length < field.minItems) return { ok: false, code: "too_few_items", detail: String(field.minItems) };
      return { ok: true, value: items.length ? { list: items } : null };
    }
    case "image": {
      if (blank(input.image)) return { ok: true, value: null };
      const img = decodeImageDataUrl(input.image);
      if (!img) return { ok: false, code: "bad_image" };
      return { ok: true, value: { image: input.image as string, mime: img.mime } };
    }
    case "file":
      // files arrive through the upload route, never through a typed answer
      return { ok: false, code: "use_upload" };
    default:
      return { ok: false, code: "unknown_type" };
  }
}

/** Is a stored value still sound for its field? (Re-checked by the server at the gate.) */
export function recheckStored(field: DataField, value: FormValue): CheckResult {
  if ("files" in value) {
    const n = value.files.length;
    if (field.maxFiles && n > field.maxFiles) return { ok: false, code: "too_many_files", detail: String(field.maxFiles) };
    if (field.minFiles && n < field.minFiles) return { ok: false, code: "too_few_files", detail: String(field.minFiles) };
    return { ok: true, value };
  }
  if ("text" in value) return checkDataAnswer(field, { text: value.text });
  if ("checked" in value) return checkDataAnswer(field, { checked: value.checked });
  if ("choices" in value) return checkDataAnswer(field, { choices: value.choices });
  if ("list" in value) return checkDataAnswer(field, { list: value.list });
  if ("image" in value) return checkDataAnswer(field, { image: value.image });
  return { ok: false, code: "unknown_value" };
}
