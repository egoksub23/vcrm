// ============================================================
// Doc Sign forms, the sender's view of a document in progress: the decisions the screen makes, kept pure so they
// can be tested. How far each person has got (parts and a bar), which parts are still open (for a reminder that
// names them), the answers so far in the way the signer gave them, the problems the server found, the device
// someone last used, and what is acceptable when the expiry is extended.
//
// The data comes from GET /api/sign/documents/[id]/progress (`StaffProgress`). Nothing here reads the network.
// ============================================================

import { overallPercent } from "../forms/completion";
import { pick, yesNoWord } from "../forms/text";
import type { StaffAnswerRow, StaffProgress, StaffRoleProgress } from "../forms/api-types";
import type { DataField, FileSummary, FormDefinition, FormValueView, PartProgress, PartState } from "../forms/types";
import type { Issue } from "../rules";
import { SIGN_LOCALES, type SignLocale } from "../types";
import { fromDateInput, toDateInput } from "./draft-options";

/** The reader's language as a Doc Sign language (anything else reads as English). */
export function asLocale(locale: string): SignLocale {
  return (SIGN_LOCALES as readonly string[]).includes(locale) ? (locale as SignLocale) : "en";
}

/** A document is a form document when it carries a form with at least one part. */
export function hasFormParts(form: FormDefinition | null | undefined): form is FormDefinition {
  return !!form && Array.isArray(form.parts) && form.parts.length > 0;
}

// ---- who has got how far -----------------------------------------------------------------------

export interface PartLine {
  key: string;
  /** 1-based position of the part in the form. */
  number: number;
  title: string;
  state: PartState;
  done: number;
  total: number;
  lastSavedAt: string | null;
  /** The part was handed to someone else (migration 166): who holds it, and whether they have completed it. */
  heldBy?: { name: string; done: boolean };
}

export interface RoleView {
  roleKey: string;
  roleLabel: string;
  signer: StaffRoleProgress["signer"];
  percent: number;
  parts: PartLine[];
  partsDone: number;
  /** The parts that are not done yet, in order. */
  unfinished: PartLine[];
  lastActivityAt: string | null;
}

/** Each role of the progress answer ready to draw, with part titles in `locale`. */
export function roleViews(progress: Pick<StaffProgress, "form" | "roles">, locale: SignLocale): RoleView[] {
  const numberOf = new Map(progress.form.parts.map((p, i) => [p.key, i + 1]));
  return progress.roles.map((r) => {
    const held = new Map((r.delegations ?? []).map((d) => [d.part, { name: d.name, done: d.done }]));
    const parts: PartLine[] = r.parts.map((p) => ({
      key: p.key,
      number: numberOf.get(p.key) ?? 0,
      title: pick(p.title, locale) || p.key,
      state: p.state,
      done: p.done,
      total: p.total,
      lastSavedAt: p.lastSavedAt ?? null,
      ...(held.has(p.key) ? { heldBy: held.get(p.key) } : {}),
    }));
    return {
      roleKey: r.roleKey,
      roleLabel: r.roleLabel,
      signer: r.signer,
      percent: clampPercent(r.percent),
      parts,
      partsDone: parts.filter((p) => p.state === "done").length,
      unfinished: parts.filter((p) => p.state !== "done"),
      lastActivityAt: r.lastActivityAt,
    };
  });
}

export function clampPercent(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

/** Parts done and in all, over every role, and the share of required answers given. */
export function overallStats(roles: readonly Pick<StaffRoleProgress, "parts">[]): { partsDone: number; partsTotal: number; percent: number } {
  const parts: PartProgress[] = roles.flatMap((r) => r.parts);
  return { partsDone: parts.filter((p) => p.state === "done").length, partsTotal: parts.length, percent: clampPercent(overallPercent(parts)) };
}

/** "4 of 6" is only meaningful when the part has required fields. */
export const showsCount = (p: Pick<PartLine, "total">): boolean => p.total > 0;

// ---- when and from what --------------------------------------------------------------------

export type DeviceKind = "phone" | "tablet" | "computer";

/** A rough kind of device from the browser's user-agent text; null when it says nothing useful. Never invented. */
export function deviceKind(agent: string | null | undefined): DeviceKind | null {
  const ua = (agent ?? "").trim();
  if (!ua) return null;
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  if (/Android/i.test(ua)) {
    if (/Mobile/i.test(ua)) return "phone";
    // A desktop-style Android browser string without "Mobile" is a tablet; a bare label ("Android Chrome") is a phone.
    return /(Chrome|Safari)\/\d/.test(ua) ? "tablet" : "phone";
  }
  if (/iPhone|iPod|Mobile|Windows Phone/i.test(ua)) return "phone";
  if (/Windows NT|Macintosh|Mac OS X|X11|Linux|CrOS|Windows/i.test(ua)) return "computer";
  return null;
}

export interface ActivityEvent {
  signer_id: string | null;
  actor_type: string;
  device: string | null;
  doc_seq: number;
}

/** What the person last used: the device on their latest recorded action that carried one, else on their row. */
export function lastDeviceOf(signerId: string | null, events: readonly ActivityEvent[] | null, rowDevice: string | null | undefined): DeviceKind | null {
  if (!signerId) return null;
  const mine = (events ?? []).filter((e) => e.signer_id === signerId && e.actor_type === "signer" && !!e.device).sort((a, b) => b.doc_seq - a.doc_seq);
  return deviceKind(mine[0]?.device) ?? deviceKind(rowDevice);
}

// ---- the answers so far --------------------------------------------------------------------

export type AnswerDisplay =
  | { kind: "empty" }
  | { kind: "text"; text: string; multiline: boolean }
  | { kind: "lines"; lines: string[] }
  | { kind: "accepted"; checked: boolean }
  | { kind: "files"; files: FileSummary[] }
  | { kind: "image"; src: string | null };

const IMAGE_SRC = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** A picture answer as something an <img> may show: only a PNG or JPEG data address, nothing else. */
export function imageSrc(value: string): string | null {
  return IMAGE_SRC.test(value) ? value : null;
}

function optionLabelOf(field: DataField | undefined, value: string, locale: SignLocale): string {
  const o = field?.options?.find((x) => x.value === value);
  return o ? pick(o.label, locale) || value : value;
}

/** One stored value, the way the signer gave it: choices by their label in `locale`, lists a line each, files by name. */
export function describeAnswer(type: DataField["type"], value: FormValueView | null, field: DataField | undefined, locale: SignLocale): AnswerDisplay {
  if (!value) return { kind: "empty" };
  if ("text" in value) {
    if (!value.text.trim()) return { kind: "empty" };
    if (type === "choice") return { kind: "text", text: optionLabelOf(field, value.text, locale), multiline: false };
    return { kind: "text", text: value.text, multiline: type === "multiline" };
  }
  if ("checked" in value) {
    if (type === "acknowledge") return { kind: "accepted", checked: value.checked };
    return { kind: "text", text: yesNoWord(value.checked, locale), multiline: false };
  }
  if ("choices" in value) {
    const lines = value.choices.map((c) => optionLabelOf(field, c, locale));
    return lines.length ? { kind: "lines", lines } : { kind: "empty" };
  }
  if ("list" in value) {
    const lines = value.list.filter((x) => x.trim() !== "");
    return lines.length ? { kind: "lines", lines } : { kind: "empty" };
  }
  if ("files" in value) return value.files.length ? { kind: "files", files: value.files } : { kind: "empty" };
  if ("image" in value) return { kind: "image", src: imageSrc(value.image) };
  return { kind: "empty" };
}

export interface AnswerRowView {
  key: string;
  label: string;
  display: AnswerDisplay;
  /** The data field's type (to word a revealed value). */
  type: DataField["type"];
  /** A sensitive field: `display` is a mask, and the value is fetched with "Reveal" (never sent with the progress). */
  sensitive: boolean;
  /** A value taken from the contact that the signer has not confirmed yet. */
  fromContact: boolean;
  /** Entered by the sender (a fixed value), not by the signer. */
  bySender: boolean;
  savedAt: string | null;
}

export interface AnswerGroup {
  partKey: string;
  title: string;
  /** The label of the role that completes the part. */
  roleLabel: string;
  rows: AnswerRowView[];
  answered: number;
}

/**
 * The answers grouped by part, parts in the form's order and fields in the form's order. The server leaves out
 * the answers a rule hides, so every row here is one the signer is shown. A part with no answers still appears (so
 * the sender sees it is empty).
 */
export function groupAnswers(progress: Pick<StaffProgress, "form" | "answers" | "roles">, locale: SignLocale): AnswerGroup[] {
  const { form } = progress;
  const fieldByKey = new Map(form.fields.map((f) => [f.key, f]));
  const fieldOrder = new Map(form.fields.map((f, i) => [f.key, i]));
  const roleLabel = (roleKey: string) => progress.roles.find((r) => r.roleKey === roleKey)?.roleLabel ?? roleKey;
  const rowsByPart = new Map<string, StaffAnswerRow[]>();
  for (const a of progress.answers) {
    const list = rowsByPart.get(a.part) ?? [];
    list.push(a);
    rowsByPart.set(a.part, list);
  }
  const viewOf = (a: StaffAnswerRow): AnswerRowView => ({
    key: a.key,
    label: pick(a.label, locale) || a.key,
    display: describeAnswer(a.type, a.value, fieldByKey.get(a.key), locale),
    type: a.type,
    sensitive: a.sensitive === true,
    fromContact: a.source === "contact",
    bySender: a.source === "sender",
    savedAt: a.savedAt,
  });
  const orderOf = (a: StaffAnswerRow) => fieldOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER;

  const groups: AnswerGroup[] = form.parts.map((p) => {
    const rows = (rowsByPart.get(p.key) ?? []).sort((a, b) => orderOf(a) - orderOf(b)).map(viewOf);
    rowsByPart.delete(p.key);
    return { partKey: p.key, title: pick(p.title, locale) || p.key, roleLabel: roleLabel(p.role), rows, answered: rows.filter((r) => r.display.kind !== "empty").length };
  });
  // answers of a part the form no longer has (a definition cannot change after sending, but a row must never vanish)
  for (const [partKey, list] of rowsByPart) {
    const rows = list.map(viewOf);
    groups.push({ partKey, title: partKey, roleLabel: list[0] ? roleLabel(list[0].role) : "", rows, answered: rows.filter((r) => r.display.kind !== "empty").length });
  }
  return groups;
}

/** Where a signer's uploaded file is fetched from (the route records the download in the history). */
export const uploadedFileUrl = (documentId: string, fileId: string): string => `/api/sign/documents/${encodeURIComponent(documentId)}/files/${encodeURIComponent(fileId)}`;

// ---- problems the server found --------------------------------------------------------------

export interface IssueView {
  /** Message key under `Sign.progress.issues`. */
  key: "doesNotFit" | "invalid" | "generic";
  /** The label of the answer it is about, in the reader's language ("" when not about one answer). */
  field: string;
  code: string;
}

/** Each issue as a message key and the label of the answer it names. */
export function issueViews(issues: readonly Issue[], form: FormDefinition, locale: SignLocale): IssueView[] {
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  return issues.map((i) => {
    const field = i.field ? pick(byKey.get(i.field)?.label, locale) || i.field : "";
    const key = i.code === "answer_does_not_fit" ? "doesNotFit" : i.code === "invalid_answers" || i.code === "invalid_answer" ? "invalid" : "generic";
    return { key, field, code: i.code };
  });
}

// ---- extending the expiry --------------------------------------------------------------------

/** The expiry can be moved while the document is open and the reader may send. */
export function canExtendExpiry(status: string, canSend: boolean): boolean {
  return canSend && (status === "sent" || status === "in_progress");
}

export type ExpiryProblem = "required" | "past" | "not_later";

/** What is wrong with a chosen day: it must come after the current expiry and after now. The chosen day ends at 23:59 local. */
export function extendProblem(dateInput: string, currentExpiryIso: string | null, now: Date): ExpiryProblem | null {
  const iso = fromDateInput(dateInput);
  if (!iso) return "required";
  const chosen = new Date(iso).getTime();
  if (chosen <= now.getTime()) return "past";
  const current = currentExpiryIso ? new Date(currentExpiryIso).getTime() : NaN;
  if (Number.isFinite(current) && chosen <= current) return "not_later";
  return null;
}

/** The earliest day the picker offers: the day the document expires now, or today when that has passed. */
export function extendMinDate(currentExpiryIso: string | null, now: Date): string {
  const today = toDateInput(now.toISOString());
  const current = currentExpiryIso ? toDateInput(currentExpiryIso) : "";
  return current && current > today ? current : today;
}

/** A suggested day: a week after the later of now and the current expiry. */
export function suggestedExpiryDate(currentExpiryIso: string | null, now: Date): string {
  const base = currentExpiryIso && new Date(currentExpiryIso).getTime() > now.getTime() ? new Date(currentExpiryIso) : now;
  return toDateInput(new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
}

/** The error codes this screen words for the progress and expiry calls (anything else reads as the generic sentence). */
export const PROGRESS_ERROR_CODES = ["document_not_found", "document_not_open", "expiry_in_the_past", "expiry_not_later", "bad_expiry", "file_not_found", "forbidden", "signed_out", "rate_limited", "network", "database_error"] as const;
const KNOWN: ReadonlySet<string> = new Set(PROGRESS_ERROR_CODES);

/** The message key under `Sign.progress` for a failure code. */
export function progressErrorKey(code: string | null | undefined): string {
  return code && KNOWN.has(code) ? `errors.${code}` : "errors.generic";
}
