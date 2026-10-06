// ============================================================
// Doc Sign editor: the sample values shown in preview mode (pure, no server call). A signature shows the
// typed name in a script font, "date signed" shows today, a field the sender fills shows its merge value.
// ============================================================

import type { PlacedField } from "../pdf/types";
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
}

export type SampleKind = "text" | "script" | "check" | "image";
export interface Sample {
  kind: SampleKind;
  text: string;
  /** A merge field whose value has not been filled in yet. */
  missing?: boolean;
}

const MERGEABLE = new Set(["text", "number", "date", "static_text"]);

/** What a field shows in preview mode. */
export function sampleValue(f: PlacedField, ctx: SampleContext): Sample {
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
