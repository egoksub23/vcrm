// ============================================================
// Doc Sign editor: the sample values shown in preview mode (pure, no server call). A signature shows the
// typed name in a script font, "date signed" shows today, a field the sender fills shows its merge value.
// ============================================================

import { pick, yesNoWord } from "../forms/text";
import type { DataField, FormDefinition } from "../forms/types";
import type { PlacedField } from "../pdf/types";
import type { SignLocale } from "../types";
import { DEFAULT_DATE_FORMAT } from "./layout";

const TOKEN_RE = /YYYY|YY|MMMM|MMM|MM|M|DD|D/g;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Write a date with the field format's tokens (DD D MM M MMM MMMM YYYY YY). Month names follow `locale`. */
export function formatDate(date: Date, format: string | undefined, locale = "en"): string {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const monthName = (style: "long" | "short") => {
    try {
      return new Intl.DateTimeFormat(locale, { month: style }).format(new Date(2000, m, 1));
    } catch {
      return new Intl.DateTimeFormat("en", { month: style }).format(new Date(2000, m, 1));
    }
  };
  return (format || DEFAULT_DATE_FORMAT).replace(TOKEN_RE, (token) => {
    switch (token) {
      case "YYYY":
        return String(y);
      case "YY":
        return pad2(y % 100);
      case "MMMM":
        return monthName("long");
      case "MMM":
        return monthName("short");
      case "MM":
        return pad2(m + 1);
      case "M":
        return String(m + 1);
      case "DD":
        return pad2(d);
      default:
        return String(d);
    }
  });
}

/** A number written the way a number field with `decimals` digits would show it. */
export function formatSampleNumber(decimals: number | undefined): string {
  const digits = Number.isInteger(decimals) ? Math.min(6, Math.max(0, decimals as number)) : 0;
  return (1234.5678).toLocaleString("en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** The first letters of each word of a name, for sample initials. */
export function initialsOf(name: string, max = 3): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, max)
    .map((w) => Array.from(w)[0]?.toUpperCase() ?? "")
    .join("");
}

export interface SampleContext {
  mergeValues?: Record<string, unknown>;
  now: Date;
  locale: string;
  /** The name shown as a typed signature (already in the reader's language). */
  signerName: string;
  /** The text a signer-filled "text" field shows when it has no label. */
  textPlaceholder: string;
  /** Forms: the template's form, so a placement that prints a data field can show a sample of that field's answer. */
  form?: FormDefinition | null;
  /** Forms: "Item 1", "Item 2" ... for the sample of a list answer (already in the reader's language). */
  sampleItem?: (n: number) => string;
}

export type SampleKind = "text" | "script" | "check" | "image";
export interface Sample {
  kind: SampleKind;
  text: string;
  /** A merge field whose value has not been filled in yet. */
  missing?: boolean;
}

const MERGEABLE = new Set(["text", "number", "date", "static_text"]);

const SAMPLE_LOCALES: readonly string[] = ["en", "ms", "zh", "ko"];

/** What a placement that prints a data field of the form shows in preview: a sample of that field's answer. */
export function boundSample(f: PlacedField, field: DataField | undefined, ctx: SampleContext): Sample {
  if (!field) return { kind: "text", text: `{{${f.data ?? ""}}}`, missing: true };
  const locale = (SAMPLE_LOCALES.includes(ctx.locale) ? ctx.locale : "en") as SignLocale;
  if (f.type === "checkbox") return { kind: "check", text: "" };
  if (f.type === "upload") return { kind: "image", text: "" };
  if (f.type === "date") return { kind: "text", text: formatDate(ctx.now, f.dateFormat, ctx.locale) };
  if (f.type === "number") return { kind: "text", text: formatSampleNumber(f.decimals ?? field.decimals) };
  const item = ctx.sampleItem ?? ((n: number) => `${n}`);
  const label = (value: string) => pick(field.options?.find((o) => o.value === value)?.label, locale) || value;
  switch (field.type) {
    case "choice":
      return { kind: "text", text: field.options?.[0] ? label(field.options[0].value) : ctx.textPlaceholder };
    case "multichoice":
      return { kind: "text", text: (field.options ?? []).slice(0, 2).map((o) => label(o.value)).join(", ") || ctx.textPlaceholder };
    case "list":
      return { kind: "text", text: [item(1), item(2)].join(f.multiline ? "\n" : ", ") };
    case "email":
      return { kind: "text", text: "name@example.com" };
    case "phone":
      return { kind: "text", text: "+60 12-345 6789" };
    case "yesno":
    case "acknowledge":
      return { kind: "text", text: yesNoWord(true, locale) };
    default:
      return { kind: "text", text: field.defaultValue || ctx.textPlaceholder };
  }
}

/** What a field shows in preview mode. */
export function sampleValue(f: PlacedField, ctx: SampleContext): Sample {
  if (f.data) return boundSample(f, ctx.form?.fields.find((x) => x.key === f.data), ctx);
  if (f.merge && MERGEABLE.has(f.type)) {
    const raw = ctx.mergeValues?.[f.merge];
    const value = raw === undefined || raw === null ? "" : String(raw);
    return value ? { kind: "text", text: value } : { kind: "text", text: `{{${f.merge}}}`, missing: true };
  }
  switch (f.type) {
    case "signature":
      return { kind: "script", text: ctx.signerName };
    case "initials":
      return { kind: "script", text: initialsOf(ctx.signerName) };
    case "name":
      return { kind: "text", text: ctx.signerName };
    case "date_signed":
    case "date":
      return { kind: "text", text: formatDate(ctx.now, f.dateFormat, ctx.locale) };
    case "number":
      return { kind: "text", text: formatSampleNumber(f.decimals) };
    case "checkbox":
      return { kind: "check", text: "" };
    case "dropdown":
      return { kind: "text", text: f.options?.[0] ?? "" };
    case "upload":
      return { kind: "image", text: "" };
    case "static_text":
      return { kind: "text", text: f.text ?? "" };
    default:
      return { kind: "text", text: f.label?.trim() || ctx.textPlaceholder };
  }
}
