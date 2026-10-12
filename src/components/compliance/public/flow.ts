// ============================================================
// The parent form (/c/<slug>), the browser's side, as pure helpers: what the form holds, the check it runs before it posts (the same parsePublicSubmission
// the server runs), the multipart post, and the mapping from the server's codes to the words of the page. No React, no network, no Node imports, so the
// markup tests and the interaction tests can use it without a DOM renderer.
// ============================================================

import { OTHER_BANK } from "@/lib/compliance/public/banks";
import { namesMatch } from "@/lib/compliance/public/names";
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

/** The bank account holder name differs from the account holder name (so the form asks for a letter). Nothing is asked until both are typed. */
export function letterNeeded(values: Pick<FormValues, "name" | "accountHolder">): boolean {
  if (values.name.trim() === "" || values.accountHolder.trim() === "") return false;
  return !namesMatch(values.name, values.accountHolder);
}

/** The form's own check before it posts: the server's rules for the details, and the files the form can see. The server decides again. */
export function checkBeforeSending(type: PublicType, values: FormValues, files: PickedFiles, rules: { maxAmount: number; banks: readonly string[] }): PublicProblems {
  const parsed = parsePublicSubmission(type, { ...values }, rules);
  const problems: PublicProblems = parsed.ok ? {} : { ...parsed.problems };
  if (parsed.ok && "declined" in parsed) return {};
  for (const f of fileFieldsFor(type)) {
    const picked = files[f.id];
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
  "wantClose", "name", "phone", "childrenFinished", "allowancesStopped", "reason", "amount", "reasonKind", "reasonText", "transactionRefs",
  "bankChoice", "bankOther", "accountNumber", "accountHolder", "letter", "proof", "declaration",
];
export const firstProblem = (problems: PublicProblems): PublicFieldId | null => FIELD_ORDER.find((id) => problems[id]) ?? null;

export interface PostMeta {
  token: string;
  email: string;
  locale: CustomerLocale;
}

/** The multipart post: the details as JSON in `payload`, and the files by their own names. The honeypot is always sent, empty. */
export function buildForm(values: FormValues, meta: PostMeta, files: PickedFiles, honeypot = ""): FormData {
  const form = new FormData();
  form.set("payload", JSON.stringify({ ...values, token: meta.token, email: meta.email, locale: meta.locale, website: honeypot }));
  for (const id of ["letter", "proof"] as const) {
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

/** A problem as a sentence, in the page's language. */
export const problemText = (words: PublicWords, code: PublicProblemCode | undefined): string => (code ? words.form.problem[code] : "");

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
