// ============================================================
// Doc Sign forms (Phase 1B): the shapes. A template can carry a *form*: ordered parts, each a list of
// data fields. Asking and printing are separate: a data field is asked once (by key) and may be printed
// by any number of placements on the PDF (a placed field whose `data` names it) or by none. Each part
// belongs to a role, so it is known before sending who fills what.
//
// Plain data, no I/O: the browser (instant feedback, the builder) and the server (the authority) both
// import this module and nothing else defines what a form is.
// ============================================================

import type { SignLocale } from "../types";

/** Text in each language. English is required and is the fallback for a language left empty. */
export type L10n = { en: string } & Partial<Record<Exclude<SignLocale, "en">, string>>;

export const DATA_FIELD_TYPES = [
  "text",
  "multiline",
  "number",
  "email",
  "phone",
  "choice",
  "multichoice",
  "yesno",
  "date",
  "list",
  "file",
  "image",
  "acknowledge",
] as const;
export type DataFieldType = (typeof DATA_FIELD_TYPES)[number];

/** Types a person types or picks (as opposed to files and pictures, which have their own routes). */
export const TYPED_TYPES: readonly DataFieldType[] = ["text", "multiline", "number", "email", "phone", "choice", "multichoice", "yesno", "date", "list", "acknowledge"];

/**
 * A condition on other answers, small enough to store, test and read back in plain words.
 * `field` names a data field of the same form.
 */
export type Rule =
  | { op: "eq"; field: string; value: string }
  | { op: "ne"; field: string; value: string }
  | { op: "in"; field: string; values: string[] }
  | { op: "empty"; field: string }
  | { op: "notEmpty"; field: string }
  | { op: "and"; rules: Rule[] }
  | { op: "or"; rules: Rule[] }
  | { op: "not"; rule: Rule };

export interface FieldOption {
  /** Stored and compared; stable (for example "sdn_bhd"). */
  value: string;
  label: L10n;
}

/** Fixed shapes for text, so a pattern is never free regular-expression text from a form author. */
export const TEXT_FORMATS = ["any", "digits", "letters", "alnum", "upper_alnum", "postcode_my"] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

export const FILE_KINDS = ["pdf", "jpg", "png"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** The contact fields an answer can fill when the form is submitted. `custom:<name>` is a custom contact field. */
export const CONTACT_FIELDS = ["name", "email", "company"] as const;

export interface DataField {
  /** Unique in the form and never the same as a placed field's key. Letters, digits, underscore. */
  key: string;
  type: DataFieldType;
  /** The part it is asked in. */
  part: string;
  label: L10n;
  help?: L10n;
  placeholder?: L10n;
  required: boolean;
  /** Required only when this rule holds (in addition to `required`). */
  requiredIf?: Rule;
  /** Shown (and asked) only when this rule holds. Hidden answers are ignored. */
  visibleIf?: Rule;

  // choice, multichoice
  options?: FieldOption[];

  // text, multiline, email, phone, number, list items
  format?: TextFormat;
  minLength?: number;
  maxLength?: number;
  // number
  min?: number;
  max?: number;
  decimals?: number;
  // list
  maxItems?: number;
  minItems?: number;
  itemFormat?: TextFormat;
  itemLength?: number;
  /** Each entry must have at least this many characters (for example a code of exactly 5 digits: 5 and 5). */
  itemMinLength?: number;
  // file
  accept?: FileKind[];
  maxMb?: number;
  maxFiles?: number;
  minFiles?: number;
  // acknowledge: the text the signer reads and accepts
  text?: L10n;

  /** The contact field this answer fills when the signer submits. */
  contactField?: string;
  /** Overwrite the contact's value, or only fill it when empty. Default "always" (the signer saw and confirmed it). */
  writeBack?: "always" | "if_empty";
  /** A value shown to start with (for example a country). */
  defaultValue?: string;
  /** Set by the sender, shown to the signer, not editable by them (for example a reference number). */
  locked?: boolean;
}

export interface FormPart {
  key: string;
  title: L10n;
  description?: L10n;
  /** The role (a signer or a filler) that completes this part. */
  role: string;
  visibleIf?: Rule;
}

export interface FormDefinition {
  version: 1;
  parts: FormPart[];
  fields: DataField[];
}

export const MAX_PARTS = 20;
export const MAX_DATA_FIELDS = 200;
export const MAX_OPTIONS = 100;
export const MAX_RULE_NODES = 20;
export const MAX_RULE_DEPTH = 4;
export const MAX_UPLOAD_MB = 10;
export const MAX_FILES_PER_FIELD = 10;

// ---- answers --------------------------------------------------------------------------------------

/** A file a signer uploaded. The path is the server's own; it never goes to a browser. */
export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
}

/** A stored file as a browser may see it. */
export type FileSummary = Omit<StoredFile, "path">;

/** What is stored for one data field (the `value` column of sign_answers). */
export type FormValue =
  | { text: string }
  | { checked: boolean }
  | { choices: string[] }
  | { list: string[] }
  | { files: StoredFile[] }
  | { image: string; mime: "image/png" | "image/jpeg" };

/** What a browser sends for a typed data field. */
export interface DataAnswerInput {
  text?: unknown;
  checked?: unknown;
  choices?: unknown;
  list?: unknown;
  image?: unknown;
}

/** The answers to a form, by data field key, any signer's. */
export type AnswerMap = Readonly<Record<string, FormValue | undefined>>;

// ---- what a signer's page is given ------------------------------------------------------------------------

export type PartState = "not_started" | "in_progress" | "done";

export interface PartProgress {
  key: string;
  state: PartState;
  /** Visible required fields answered, and how many there are. */
  done: number;
  total: number;
  /** Visible fields in the part (required or not). */
  visible: number;
  /** When the last answer in this part was saved. */
  lastSavedAt?: string | null;
}

/** The form as a signer's page gets it: only their role's parts, with files shown as summaries. */
export interface SignerFormView {
  definition: FormDefinition;
  /** The part keys this signer completes, in order. */
  partKeys: string[];
  /** Answers to the fields of those parts, plus any other field a rule of theirs refers to. */
  answers: Record<string, FormValueView>;
  /** The keys of answers that came from the contact and the signer has not yet confirmed. */
  unconfirmed: string[];
  progress: PartProgress[];
  /** The sign step is open: every required field of this signer's parts is answered. */
  ready: boolean;
}

/** A stored value with file paths removed. */
export type FormValueView = Exclude<FormValue, { files: StoredFile[] }> | { files: FileSummary[] };
