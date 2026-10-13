// ============================================================
// The parent form (/c/<slug>), the browser's side, as pure helpers: what the form holds, the check it runs before it posts (the same parsePublicSubmission
// the server runs), the multipart post, and the mapping from the server's codes to the words of the page. No React, no network, no Node imports, so the
// markup tests and the interaction tests can use it without a DOM renderer.
// ============================================================

import { cleanEmail } from "@/lib/compliance/public/amount";
import { OTHER_BANK } from "@/lib/compliance/public/banks";
import { PUBLIC_MAX_FILE_BYTES, fileFieldsFor, parsePublicSubmission, type PublicFieldId, type PublicProblemCode, type PublicProblems, type PublicType } from "@/lib/compliance/public/validate";
import type { PublicWords } from "@/lib/compliance/public/words";
import type { CustomerLocale } from "@/lib/compliance/types";

/** Everything the form holds while it is open. Strings and booleans only, so it can be posted as it is. */
export interface FormValues {
  wantClose: "" | "yes" | "no";
  name: string;
  phone: string;
  childrenFinished: boolean;
  allowancesStopped: boolean;
  reason: string;
  amount: string;
  reasonKind: "" | "over_topup" | "other";
  reasonText: string;
  transactionRefs: string;
  /** "Does this bank account belong to you, the Vircle account holder?" Nothing is chosen at first: the parent must answer. */
  bankOwn: "" | "yes" | "no";
  bankChoice: string;
  bankOther: string;
  accountNumber: string;
  accountHolder: string;
  declaration: boolean;
}

export const emptyValues = (): FormValues => ({
  wantClose: "",
  name: "",
  phone: "",
  childrenFinished: false,
  allowancesStopped: false,
  reason: "",
  amount: "",
  reasonKind: "",
  reasonText: "",
  transactionRefs: "",
  bankOwn: "",
  bankChoice: "",
  bankOther: "",
  accountNumber: "",
  accountHolder: "",
  declaration: false,
});

export interface PickedFile {
  name: string;
  size: number;
  /** The file itself (absent in tests). */
  file?: File;
}
export type PickedFiles = Partial<Record<"letter" | "proof", PickedFile | null>>;

/** The parent says the bank account is somebody else's, so the form asks for the authorization letter. Nothing is asked until the question is answered. */
export function letterNeeded(values: Pick<FormValues, "bankOwn">): boolean {
  return values.bankOwn === "no";
}

/** The form's own check before it posts: the server's rules for the details, and the files the form can see. The server decides again. */
export function checkBeforeSending(
  type: PublicType,
  values: FormValues,
  files: PickedFiles,
  rules: { maxAmount: number; banks: readonly string[]; phoneFromCase?: boolean },
  /** The personal closure form (migration 185): the email the parent typed is required and checked here (there is no emailed code to prove it). */
  extra: { email?: string } = {},
): PublicProblems {
  const parsed = parsePublicSubmission(type, { ...values }, rules);
  const problems: PublicProblems = parsed.ok ? {} : { ...parsed.problems };
  if (parsed.ok && "declined" in parsed) return {};
  if (extra.email !== undefined && !cleanEmail(extra.email)) problems.email = extra.email.trim() === "" ? "required" : "invalid";
  for (const f of fileFieldsFor(type)) {
    const picked = files[f.id];
    // a letter chosen earlier and kept after the answer became Yes is not checked: it is not sent
    if (f.id === "letter" && !letterNeeded(values)) continue;
    if (picked) {
      if (picked.size > PUBLIC_MAX_FILE_BYTES) problems[f.id] = "file_size";
      else if (picked.size === 0) problems[f.id] = "file_required";
    } else if (f.id === "letter" && letterNeeded(values)) {
      problems.letter = "file_required";
    }
  }
  return problems;
}

/** The first control with a problem, in the order the form lists them (so focus goes to the top-most one). */
export const FIELD_ORDER: PublicFieldId[] = [
  "wantClose", "name", "phone", "email", "childrenFinished", "allowancesStopped", "reason", "amount", "reasonKind", "reasonText", "transactionRefs",
  "bankOwn", "bankChoice", "bankOther", "accountNumber", "accountHolder", "letter", "proof", "declaration",
];
export const firstProblem = (problems: PublicProblems): PublicFieldId | null => FIELD_ORDER.find((id) => problems[id]) ?? null;

export interface PostMeta {
  token: string;
  email: string;
  locale: CustomerLocale;
  /** The personal closure form's own token (migration 185): posted back with the form. */
  linkToken?: string;
}

/** The multipart post: the details as JSON in `payload`, and the files by their own names. The honeypot is always sent, empty. */
export function buildForm(values: FormValues, meta: PostMeta, files: PickedFiles, honeypot = ""): FormData {
  const form = new FormData();
  form.set("payload", JSON.stringify({ ...values, token: meta.token, email: meta.email, locale: meta.locale, website: honeypot, ...(meta.linkToken ? { linkToken: meta.linkToken } : {}) }));
  for (const id of ["letter", "proof"] as const) {
    // a letter picked while the answer was No is dropped when the answer is Yes at the end: it is not sent
    if (id === "letter" && !letterNeeded(values)) continue;
    const f = files[id];
    if (f?.file) form.set(id, f.file, f.name);
  }
  return form;
}

/** The server's code for a failed submission as the key of the sentence in `form.errors`. */
export function submitErrorKey(code: string): keyof PublicWords["form"]["errors"] {
  switch (code) {
    case "session_invalid":
      return "session_invalid";
    case "rate_limited":
      return "rate_limited";
    case "token_invalid":
    case "token_expired":
    case "token_too_fast":
      return "token";
    case "too_large":
      return "too_large";
    case "unavailable":
      return "unavailable";
    case "network":
      return "network";
    default:
      return "failed";
  }
}

/** The personal closure form: the server found no usable link (unknown, used, withdrawn, replaced, expired, or Compliance off). The page then shows its one calm page. */
export const linkIsGone = (code: string): boolean => code === "not_found";

/** The server's code for a failed code request or entry as the key of the sentence in `verify.errors`. */
export function verifyErrorKey(code: string): keyof PublicWords["verify"]["errors"] {
  switch (code) {
    case "invalid_email":
    case "send_failed":
    case "rate_limited":
    case "wrong_code":
    case "expired":
    case "too_many_attempts":
    case "no_code":
    case "captcha_failed":
    case "unavailable":
    case "network":
      return code;
    case "not_found":
      return "unavailable";
    default:
      return "network";
  }
}

/** A problem as a sentence, in the page's language. The Yes / No question about the bank account has its own sentence for "not answered". */
export function problemText(words: PublicWords, code: PublicProblemCode | undefined, id?: PublicFieldId): string {
  if (!code) return "";
  if (id === "bankOwn" && code === "required") return words.form.bank.own.required;
  return words.form.problem[code];
}

/** The label of the bank account holder name: it says "(as on the bank account)" while the account is somebody else's. */
export const holderLabel = (words: PublicWords, values: Pick<FormValues, "bankOwn">): string => (values.bankOwn === "no" ? words.form.bank.holderOther : words.form.bank.holder);

/** The sentence under a code that wants it (the tries left in a wrong code). */
export function wrongCodeText(words: PublicWords, attemptsLeft: number): string {
  return words.verify.errors.wrong_code.replace("{left}", String(attemptsLeft));
}

/** Where the page starts: the form if a session is active and the address is known, the address step otherwise. */
export type Step = "verify" | "form" | "done" | "declined";
export function startStep(sessionActive: boolean): Step {
  return sessionActive ? "form" : "verify";
}

/** Is a bank choice the "other bank" row (the form then asks for the name)? */
export const isOtherBank = (choice: string): boolean => choice === OTHER_BANK;

/** The address as the browser keeps it for a page refresh within the session (session storage: gone when the tab closes). */
export const EMAIL_STORAGE_KEY = "halo-cmp-email";
