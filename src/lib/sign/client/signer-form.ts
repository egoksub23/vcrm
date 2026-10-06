// ============================================================
// Doc Sign, signing page, forms in parts: the logic of the form screens that has no screen in it. Pure,
// so it is tested without a browser (signer-form.test.ts). The shapes and the rules are the shared forms
// module (src/lib/sign/forms); this file only works out what the signer's page needs from them:
//
//   state              the form as the page holds it, and the small changes made to it (an answer, an upload)
//   checking           one value for its field, the way the server will (without Node's Buffer)
//   overview           each part as a row, what to continue with, what still blocks signing
//   uploads            a file checked before it is sent
//   server answers     the codes the server answers with, and the part and field each belongs to
//   review             what the review step draws over the page
//
// Only the browser-safe files of the forms module are imported (not its index, which pulls in the PDF engine).
// ============================================================

import type { PlacedField } from "../pdf/types";
import type { AnswerInput } from "../rules";
import { checkDataAnswer, type CheckResult } from "../forms/check";
import { fieldsOfPart, partProgress } from "../forms/completion";
import type { FitProblem, PrintedValue } from "../forms/api-types";
import { fieldVisible, partVisible } from "../forms/rules";
import {
  FILE_KINDS,
  MAX_FILES_PER_FIELD,
  MAX_UPLOAD_MB,
  type AnswerMap,
  type DataAnswerInput,
  type DataField,
  type FileKind,
  type FileSummary,
  type FormDefinition,
  type FormPart,
  type FormValue,
  type FormValueView,
  type PartProgress,
  type PartState,
  type SignerFormView,
  type TextFormat,
} from "../forms/types";
import type { SignIssue } from "./api";
import { checkImageDataUrl, sniffImage } from "./signer-images";

// ---- the form as the page holds it --------------------------------------------------------------------------

/** Why an answer was turned down, by a stable code the screen words; `detail` is a limit or a number to show. */
export interface FormRejection {
  code: string;
  detail?: string;
}
export type FormRejections = Record<string, FormRejection>;

/**
 * The form as the signing page keeps it. `answers` may hold `null` for an answer the signer cleared: the
 * server still has the old one until the save lands, and a refresh must not bring it back.
 */
export interface FormState {
  definition: FormDefinition;
  partKeys: string[];
  answers: Record<string, FormValueView | null>;
  unconfirmed: string[];
  progress: PartProgress[];
  ready: boolean;
}

export function formStateFromView(view: SignerFormView): FormState {
  return { definition: view.definition, partKeys: view.partKeys, answers: { ...view.answers }, unconfirmed: view.unconfirmed, progress: view.progress, ready: view.ready };
}

/** The form as the screens take it: answers with nothing cleared. */
export function formViewOf(state: FormState): SignerFormView {
  const answers: Record<string, FormValueView> = {};
  for (const [key, value] of Object.entries(state.answers)) if (value) answers[key] = value;
  return { definition: state.definition, partKeys: state.partKeys, answers, unconfirmed: state.unconfirmed, progress: state.progress, ready: state.ready };
}

/**
 * The page again from the server: it brings the definition, the parts and what the server says about
 * progress; what the signer entered here (newer than what the server last heard) is kept.
 */
export function mergeFormView(prev: FormState | null, next: SignerFormView): FormState {
  const fresh = formStateFromView(next);
  if (!prev) return fresh;
  return { ...fresh, answers: { ...next.answers, ...prev.answers }, unconfirmed: next.unconfirmed.filter((k) => prev.answers[k] === undefined) };
}

const toView = (value: FormValue): FormValueView => ("files" in value ? { files: value.files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, sha256: f.sha256 })) } : value);

/** An answer given, or cleared (`null`). An answer the signer made is theirs: it is no longer one "from our records". */
export function withAnswer(state: FormState, key: string, value: FormValue | null): FormState {
  return { ...state, answers: { ...state.answers, [key]: value ? toView(value) : null }, unconfirmed: state.unconfirmed.filter((k) => k !== key) };
}

/** What the server said after a save. */
export function withSaved(state: FormState, result: { progress?: PartProgress[]; ready?: boolean; unconfirmed?: string[] }): FormState {
  return { ...state, progress: result.progress ?? state.progress, ready: result.ready ?? state.ready, unconfirmed: result.unconfirmed ?? state.unconfirmed };
}

const filesOf = (state: FormState, key: string): FileSummary[] => {
  const v = state.answers[key];
  return v && "files" in v ? v.files : [];
};

/** A file the server accepted joins the field's files. */
export function withUpload(state: FormState, key: string, file: FileSummary, result: { progress: PartProgress[]; ready: boolean }): FormState {
  const files = [...filesOf(state, key).filter((f) => f.id !== file.id), file];
  return { ...state, answers: { ...state.answers, [key]: { files } }, progress: result.progress, ready: result.ready };
}

/** A file removed leaves the field's files; none left is no answer. */
export function withoutUpload(state: FormState, key: string, fileId: string, result: { progress: PartProgress[]; ready: boolean }): FormState {
  const files = filesOf(state, key).filter((f) => f.id !== fileId);
  return { ...state, answers: { ...state.answers, [key]: files.length ? { files } : null }, progress: result.progress, ready: result.ready };
}

/** These parts were confirmed: their answers from the contact are the signer's own now. */
export function withConfirmed(state: FormState, partKey: string): FormState {
  const keys = new Set(state.definition.fields.filter((f) => f.part === partKey).map((f) => f.key));
  return { ...state, unconfirmed: state.unconfirmed.filter((k) => !keys.has(k)) };
}

// ---- answers: what is typed, what is held ---------------------------------------------------------------------

/**
 * The shared answer map the rules read, from the answers as the page holds them. A file is held without the
 * server's own path; the rules only ever look at how many files and what they are called.
 */
export function toAnswerMap(answers: Readonly<Record<string, FormValueView | null | undefined>>): AnswerMap {
  const out: Record<string, FormValue> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!value) continue;
    out[key] = "files" in value ? { files: value.files.map((f) => ({ ...f, path: "" })) } : value;
  }
  return out;
}

/**
 * Is this input acceptable for its field? The shared check, except for a picture: the shared one reads the
 * bytes with Node's Buffer, so the browser's own test is used (the same limits) and the server decides in the end.
 */
export function checkFormInput(field: DataField, input: DataAnswerInput | undefined): CheckResult {
  if (field.type === "image") {
    const image = input?.image;
    if (image === undefined || image === null || image === "") return { ok: true, value: null };
    if (!checkImageDataUrl(image)) return { ok: false, code: "bad_image" };
    const mime = sniffImage(image as string);
    return mime ? { ok: true, value: { image: image as string, mime } } : { ok: false, code: "bad_image" };
  }
  return checkDataAnswer(field, input);
}

/** What a control shows for a stored answer. */
export function inputFromView(value: FormValueView | null | undefined): DataAnswerInput {
  if (!value) return {};
  if ("text" in value) return { text: value.text };
  if ("checked" in value) return { checked: value.checked };
  if ("choices" in value) return { choices: value.choices };
  if ("list" in value) return { list: value.list };
  if ("image" in value) return { image: value.image };
  return {};
}

export type Drafts = Record<string, DataAnswerInput>;

/**
 * The answers as they stand while the signer types: what the page holds, with every draft that is
 * acceptable laid over it (so a condition on it works at once). A draft that is not acceptable changes
 * nothing: the last acceptable answer stands, as it does on the server.
 */
export function effectiveAnswers(definition: FormDefinition, answers: Readonly<Record<string, FormValueView | null | undefined>>, drafts: Drafts): AnswerMap {
  const out: Record<string, FormValue | undefined> = { ...toAnswerMap(answers) };
  for (const field of definition.fields) {
    if (field.type === "file") continue;
    const draft = drafts[field.key];
    if (!draft) continue;
    const r = checkFormInput(field, draft);
    if (!r.ok) continue;
    if (r.value) out[field.key] = r.value;
    else delete out[field.key];
  }
  return out;
}

/** The drafts that are not acceptable, for the fields now shown, with why. */
export function invalidDrafts(definition: FormDefinition, answers: AnswerMap, drafts: Drafts): FormRejections {
  const out: FormRejections = {};
  for (const field of definition.fields) {
    const draft = drafts[field.key];
    if (!draft || field.type === "file" || !fieldVisible(definition, field, answers)) continue;
    const r = checkFormInput(field, draft);
    if (!r.ok) out[field.key] = { code: r.code, detail: r.detail };
  }
  return out;
}

export const partOfField = (definition: FormDefinition, key: string): string | undefined => definition.fields.find((f) => f.key === key)?.part;

// ---- the overview ----------------------------------------------------------------------------------------------

export interface PartRow extends PartProgress {
  part: FormPart;
  /** 1 for the first part shown. */
  number: number;
  /** An answer typed here that is not acceptable and so is not saved. */
  needsChange: boolean;
}

/** Each part this signer completes that is shown now, in order, with where it stands. `lastSavedAt` is the server's. */
export function partRows(definition: FormDefinition, partKeys: readonly string[], answers: AnswerMap, progress: readonly PartProgress[], invalidKeys: ReadonlySet<string> = new Set()): PartRow[] {
  const byKey = new Map(definition.parts.map((p) => [p.key, p]));
  const saved = new Map(progress.map((p) => [p.key, p.lastSavedAt ?? null]));
  const rows: PartRow[] = [];
  for (const key of partKeys) {
    const part = byKey.get(key);
    if (!part || !partVisible(part, answers)) continue;
    const p = partProgress(definition, part, answers, saved.get(key));
    const needsChange = fieldsOfPart(definition, key, answers).some((f) => invalidKeys.has(f.key));
    rows.push({ ...p, part, number: rows.length + 1, needsChange });
  }
  return rows;
}

/** A part still stands in the way of signing: it has required answers not yet given. */
export const needsWork = (row: PartRow): boolean => row.total > 0 && row.done < row.total;

/** The part "Continue" goes to: the first that still has required answers to give. */
export function firstUnfinished(rows: readonly PartRow[]): PartRow | undefined {
  return rows.find(needsWork);
}

/** The part after `key`, in order. */
export function partAfter(rows: readonly PartRow[], key: string): PartRow | undefined {
  const i = rows.findIndex((r) => r.part.key === key);
  return i >= 0 ? rows[i + 1] : undefined;
}

/** How many parts still have required answers to give. */
export const partsLeft = (rows: readonly PartRow[]): number => rows.filter(needsWork).length;

/** The word for a part's state on the overview: a change to make comes first. */
export type RowStatus = PartState | "needs_change";
export const rowStatus = (row: PartRow): RowStatus => (row.needsChange ? "needs_change" : row.state);

/** Required answers still to give in one part. */
export const requiredLeft = (row: Pick<PartRow, "done" | "total">): number => Math.max(0, row.total - row.done);

/** The newest time any part was saved, or null when nothing was. */
export function latestSaved(progress: readonly PartProgress[]): string | null {
  let best: number | null = null;
  let iso: string | null = null;
  for (const p of progress) {
    if (!p.lastSavedAt) continue;
    const at = Date.parse(p.lastSavedAt);
    if (Number.isFinite(at) && (best === null || at > best)) {
      best = at;
      iso = p.lastSavedAt;
    }
  }
  return iso;
}

export type SavedAgo = { kind: "now" } | { kind: "ago"; value: number; unit: "minute" | "hour" | "day" };

/** "just now", "2 minutes ago", "3 hours ago" as numbers a formatter words; null when the time is not a time. `now` is a time in ms. */
export function savedAgo(iso: string | null | undefined, now: number): SavedAgo | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return { kind: "now" };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { kind: "ago", value: -Math.max(1, minutes), unit: "minute" };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { kind: "ago", value: -hours, unit: "hour" };
  return { kind: "ago", value: -Math.round(hours / 24), unit: "day" };
}

// ---- the fields of a part -----------------------------------------------------------------------------------------

/** What a field says about its shape, as a message key under `format.` (none for free text). */
export const formatKey = (format: TextFormat | undefined): string | null => (format && format !== "any" ? format : null);

/** How many entries a list field takes (the shared check's own default when the author set none). */
export function listLimit(field: DataField): number {
  return field.maxItems ?? 20;
}

// ---- files -------------------------------------------------------------------------------------------------------------

const KIND_EXTENSIONS: Record<FileKind, string[]> = { pdf: [".pdf"], jpg: [".jpg", ".jpeg"], png: [".png"] };
const KIND_MIMES: Record<FileKind, string[]> = { pdf: ["application/pdf"], jpg: ["image/jpeg", "image/jpg", "image/pjpeg"], png: ["image/png", "image/x-png"] };

export const KIND_LABEL: Record<FileKind, string> = { pdf: "PDF", jpg: "JPG", png: "PNG" };

/** The kinds a file field takes: the field's own list, or all three. */
export const acceptedKinds = (field: Pick<DataField, "accept">): FileKind[] => (field.accept && field.accept.length > 0 ? field.accept : [...FILE_KINDS]);

/** The `accept` of a file input: extensions and types, so a phone offers the camera and the library for pictures. */
export function acceptAttribute(field: Pick<DataField, "accept">): string {
  return acceptedKinds(field)
    .flatMap((k) => [...KIND_EXTENSIONS[k], ...KIND_MIMES[k].slice(0, 1)])
    .join(",");
}

/** Does the field take pictures (so a phone can offer to take one)? */
export const acceptsPictures = (field: Pick<DataField, "accept">): boolean => acceptedKinds(field).some((k) => k === "jpg" || k === "png");

export const maxFileMb = (field: Pick<DataField, "maxMb">): number => Math.min(field.maxMb ?? 5, MAX_UPLOAD_MB);
export const maxFileCount = (field: Pick<DataField, "maxFiles">): number => field.maxFiles ?? MAX_FILES_PER_FIELD;

/**
 * Is this file acceptable before it is sent? The name's ending must be one of the field's kinds, and the
 * type the device gave (when it gave one) must agree; then size and how many. The server checks what the
 * file really is, so this only saves a trip. The answer is a code the screen words, or null.
 */
export function fileProblem(field: Pick<DataField, "accept" | "maxMb" | "maxFiles">, file: { name: string; type: string; size: number }, existing: number): FormRejection | null {
  const max = maxFileCount(field);
  if (existing >= max) return { code: "too_many_files", detail: String(max) };
  const name = file.name.toLowerCase();
  const kinds = acceptedKinds(field);
  if (!kinds.some((k) => KIND_EXTENSIONS[k].some((ext) => name.endsWith(ext)))) return { code: "file_type" };
  const type = file.type.trim().toLowerCase();
  if (type && !kinds.some((k) => KIND_MIMES[k].includes(type))) return { code: "file_type" };
  if (file.size <= 0) return { code: "file_empty" };
  const mb = maxFileMb(field);
  if (file.size > mb * 1024 * 1024) return { code: "file_too_large", detail: String(mb) };
  return null;
}

/** "840 KB", "1.2 MB": a size a person reads. Two significant figures. */
export function formatBytes(bytes: number): string {
  if (!(bytes >= 0)) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// ---- the words for a code -------------------------------------------------------------------------------------------

/** Every code the screens word on purpose: the shared check's, the upload's and the server's. Anything else reads as the general sentence. */
export const PROBLEM_CODES = [
  "bad_text",
  "text_too_long",
  "text_too_short",
  "format_digits",
  "format_letters",
  "format_alnum",
  "format_upper_alnum",
  "format_postcode_my",
  "bad_email",
  "bad_phone",
  "not_a_number",
  "too_many_decimals",
  "number_too_small",
  "number_too_big",
  "not_a_date",
  "not_an_option",
  "not_yes_no",
  "bad_item",
  "item_too_long",
  "item_too_short",
  "too_many_items",
  "too_few_items",
  "duplicate_item",
  "bad_image",
  "use_upload",
  "file_type",
  "file_too_large",
  "file_empty",
  "document_upload_limit",
  "too_many_files",
  "too_few_files",
  "upload_failed",
  "network",
  "rate_limited",
  "not_your_field",
  "not_shown",
  "missing_required",
  "answer_does_not_fit",
  "generic",
] as const;

/** The message key (under `problems.`) for a code. A list entry's shape reads like the field's: `item_format_digits` is `format_digits`. */
export function problemKey(code: string | null | undefined): string {
  if (!code) return "generic";
  const own = code.startsWith("item_format_") ? `format_${code.slice("item_format_".length)}` : code;
  return (PROBLEM_CODES as readonly string[]).includes(own) ? own : "generic";
}

/** The server says "this kind of file is not accepted here" three ways: not a PDF, JPG or PNG at all, or not one this field takes. */
const FILE_TYPE_CODES = new Set(["file_type", "file_type_not_allowed", "unsupported_file"]);

/** A failed upload or removal as a rejection: the code the server gave when it is one the screen words, with the field's own limits. */
export function uploadFailure(field: Pick<DataField, "maxMb" | "maxFiles">, err: { code?: string }): FormRejection {
  const code = err.code ?? "upload_failed";
  if (code === "file_too_large") return { code, detail: String(maxFileMb(field)) };
  if (code === "too_many_files") return { code, detail: String(maxFileCount(field)) };
  if (FILE_TYPE_CODES.has(code)) return { code: "file_type" };
  if (code === "file_empty" || code === "document_upload_limit" || code === "network" || code === "rate_limited") return { code };
  return { code: "upload_failed" };
}

// ---- answers from the server, and where they belong ---------------------------------------------------------------

export interface IssueTargets {
  /** The answers the server turned down, by data field key (a missing one included). */
  rejections: FormRejections;
  /** The first part (in the form's order) with a problem, and the first field in it. */
  firstPart: string | null;
  firstField: string | null;
  /** Answers too long for where they print. */
  fit: FitProblem[];
}

/**
 * The issues of a failed "complete" (`missing_required`, `invalid_answers`, `answer_does_not_fit`) as the part
 * and the field each belongs to. An issue about something that is not a data field (a field on the page) is left to the page.
 * An answer too long for where it prints is kept apart (`fit`, for the review step's list) unless `fitAsRejection`: a person
 * who only fills in has no review step, so it is marked on its field like any other answer turned down.
 */
export function mapFormIssues(definition: FormDefinition, partKeys: readonly string[], issues: readonly SignIssue[], fitAsRejection = false): IssueTargets {
  const known = new Map(definition.fields.map((f) => [f.key, f]));
  const rejections: FormRejections = {};
  const fit: FitProblem[] = [];
  for (const issue of issues) {
    if (!issue.field || !known.has(issue.field)) continue;
    if (issue.code === "answer_does_not_fit") {
      fit.push({ field: issue.field, placement: issue.detail ?? "" });
      // a person with no review step is told on the answer itself
      if (fitAsRejection) rejections[issue.field] = { code: issue.code };
    } else rejections[issue.field] = { code: issue.code, detail: issue.detail };
  }
  let firstPart: string | null = null;
  let firstField: string | null = null;
  for (const partKey of partKeys) {
    const field = definition.fields.find((f) => f.part === partKey && rejections[f.key]);
    if (field) {
      firstPart = partKey;
      firstField = field.key;
      break;
    }
  }
  return { rejections, firstPart, firstField, fit };
}

/**
 * The rejections of a save (`PUT answers`) that the screen should show. A field that is no longer shown
 * (a condition changed while its answer was on its way) is nothing to tell the signer.
 */
export function visibleRejections(rejected: readonly { field: string; code: string; detail?: string }[], definition: FormDefinition): FormRejections {
  const known = new Set(definition.fields.map((f) => f.key));
  const out: FormRejections = {};
  for (const r of rejected) if (known.has(r.field) && r.code !== "not_shown") out[r.field] = { code: r.code, detail: r.detail };
  return out;
}

// ---- review ------------------------------------------------------------------------------------------------------------

/** The kinds of placement that draw a picture. */
const PICTURE_PLACEMENTS = new Set<PlacedField["type"]>(["upload", "signature", "initials"]);

/**
 * What the review step draws over the page for the bound placements: the server's printed text and ticks and,
 * for a placement that draws a picture (the company stamp), the picture the signer gave.
 */
export function printedPreviews(fields: readonly PlacedField[], printed: Readonly<Record<string, PrintedValue>>, form: Pick<SignerFormView, "answers"> | null): { field: PlacedField; input: AnswerInput }[] {
  const out: { field: PlacedField; input: AnswerInput }[] = [];
  for (const field of fields) {
    if (!field.data) continue;
    const p = printed[field.key];
    if (p?.checked) out.push({ field, input: { checked: true } });
    else if (p?.text) out.push({ field, input: { text: p.text } });
    else if (PICTURE_PLACEMENTS.has(field.type)) {
      const answer = form?.answers[field.data];
      if (answer && "image" in answer) out.push({ field, input: { image: answer.image } });
    }
  }
  return out;
}

/** The fit problems with the part each belongs to, for the list that blocks signing. One per answer (several places may print it). */
export function fitTargets(definition: FormDefinition, problems: readonly FitProblem[]): { field: DataField; part: string }[] {
  const seen = new Set<string>();
  const out: { field: DataField; part: string }[] = [];
  for (const p of problems) {
    if (seen.has(p.field)) continue;
    const field = definition.fields.find((f) => f.key === p.field);
    if (!field) continue;
    seen.add(p.field);
    out.push({ field, part: field.part });
  }
  return out;
}

// ---- when an error is shown ----------------------------------------------------------------------------------------

/**
 * Codes that only mean "not finished yet" while someone is still typing (half an email address, a number not
 * yet long enough). They are shown when the person leaves the field, not on the first keystroke; every other
 * problem (a wrong character, too long) is shown at once.
 */
const WHILE_TYPING_OK = new Set(["bad_email", "bad_phone", "text_too_short", "too_few_items", "number_too_small", "not_a_number", "not_a_date"]);
export const showWhileTyping = (code: string): boolean => !WHILE_TYPING_OK.has(code);

/** May the person finish from the review step? Only once the printed answers are in and none is too long for its place. */
export function reviewGate(review: { status: "idle" | "loading" | "ready" | "error"; fitProblems?: readonly FitProblem[] }): { canFinish: boolean; fitCount: number } {
  const fitCount = review.status === "ready" ? new Set((review.fitProblems ?? []).map((p) => p.field)).size : 0;
  return { canFinish: review.status === "ready" && fitCount === 0, fitCount };
}

/** The codes of a failed call that only a form has: worded by the form's own messages. */
export const FORM_ERROR_CODES = ["answer_does_not_fit", "form_incomplete"] as const;
