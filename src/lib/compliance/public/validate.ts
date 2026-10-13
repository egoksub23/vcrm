// ============================================================
// Compliance requests, the public forms: what a parent may submit, checked. Pure; browser-safe (the form runs the same check before it posts, so a mistake
// is shown at once; the server runs it again and trusts nothing the browser said).
//
// The submission is a plain object (the "payload" of the multipart post). Nothing is guessed: a value that is not what the field asks for is a problem
// with a code, and the page words the code in the parent's language. The refusals that matter most are enforced here and nowhere else in the
// browser's reach: a closure without its acknowledgements is never accepted, and a bank account holder name that does not match the Vircle account
// holder name needs an authorization letter.
// ============================================================

import { malaysianPhone, bankAccountNumber, cleanLine, cleanText, parseAmount } from "./amount";
import { chosenBank } from "./banks";
import { namesMatch } from "./names";

export const PUBLIC_TYPES = ["closure", "withdrawal"] as const;
export type PublicType = (typeof PUBLIC_TYPES)[number];
export const isPublicType = (v: unknown): v is PublicType => v === "closure" || v === "withdrawal";

export type PublicProblemCode = "required" | "invalid" | "too_long" | "must_acknowledge" | "not_a_choice" | "too_small" | "too_large" | "too_many_decimals" | "file_required" | "file_type" | "file_size";

/** The ids of the form's controls (the page puts a problem next to the control with the same id). */
export type PublicFieldId =
  | "name"
  | "email"
  | "phone"
  | "wantClose"
  | "childrenFinished"
  | "allowancesStopped"
  | "reason"
  | "amount"
  | "reasonKind"
  | "reasonText"
  | "transactionRefs"
  | "bankChoice"
  | "bankOther"
  | "accountNumber"
  | "accountHolder"
  | "letter"
  | "proof"
  | "declaration";
export type PublicProblems = Partial<Record<PublicFieldId, PublicProblemCode>>;

export interface PublicRules {
  /** The largest amount a withdrawal accepts (RM). */
  maxAmount: number;
  /** The banks the list offers. */
  banks: readonly string[];
  /**
   * The registered phone number is not asked: it comes from the chat and is already on the case (the personal closure form link, migration 185). The
   * value's `phone` is then empty and the service keeps the case's own.
   */
  phoneFromCase?: boolean;
}

export interface PublicValue {
  type: PublicType;
  name: string;
  phone: string;
  /** The answers of the type's fields, by key (the sensitive ones included: the service encrypts those). */
  answers: Record<string, unknown>;
  /** The bank account holder name differs from the Vircle account holder name: an authorization letter must come with it. */
  needsLetter: boolean;
}

export type PublicParse = { ok: true; value: PublicValue } | { ok: true; declined: true } | { ok: false; problems: PublicProblems };

const REASON_KINDS = ["over_topup", "other"] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

const yes = (v: unknown): boolean => v === true || v === "true" || v === "yes";

/** The bank account holder name differs from the Vircle account holder name (so a letter is needed). Either name empty counts as different. */
export const needsAuthorizationLetter = (accountHolder: string, bankHolder: string): boolean => !namesMatch(accountHolder, bankHolder);

/**
 * Check a submission of the closure or withdrawal form. The email is NOT part of it: it comes from the verified session (the service compares the typed
 * address to the session's before it gets here).
 */
export function parsePublicSubmission(type: PublicType, body: unknown, rules: PublicRules): PublicParse {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const problems: PublicProblems = {};
  const bad = (id: PublicFieldId, code: PublicProblemCode) => {
    if (!problems[id]) problems[id] = code;
  };

  // closure: "Do you want to close your E-Wallet account?" No: nothing is created
  if (type === "closure") {
    if (b.wantClose === "no" || b.wantClose === false) return { ok: true, declined: true };
    if (!(b.wantClose === "yes" || b.wantClose === true)) bad("wantClose", "required");
  }

  const name = cleanLine(b.name, 120);
  if (!name) bad("name", typeof b.name === "string" && b.name.trim().length > 120 ? "too_long" : "required");
  const phone = rules.phoneFromCase ? "" : malaysianPhone(b.phone);
  if (!rules.phoneFromCase && !phone) bad("phone", typeof b.phone === "string" && b.phone.trim() !== "" ? "invalid" : "required");

  const answers: Record<string, unknown> = {};

  if (type === "closure") {
    if (!yes(b.childrenFinished)) bad("childrenFinished", "must_acknowledge");
    if (!yes(b.allowancesStopped)) bad("allowancesStopped", "must_acknowledge");
    answers.confirm_closure = true;
    answers.children_finished_school = yes(b.childrenFinished);
    answers.allowances_cancelled = yes(b.allowancesStopped);
    if (typeof b.reason === "string" && b.reason.trim() !== "") {
      const r = cleanText(b.reason, 1000);
      if (!r) bad("reason", "too_long");
      else answers.reason = r;
    }
  } else {
    const amount = parseAmount(b.amount, rules.maxAmount);
    if (!amount.ok) bad("amount", amount.code);
    else answers.amount = amount.value;
    const kind = typeof b.reasonKind === "string" ? b.reasonKind : "";
    if (!(REASON_KINDS as readonly string[]).includes(kind)) bad("reasonKind", kind === "" ? "required" : "not_a_choice");
    const extra = typeof b.reasonText === "string" && b.reasonText.trim() !== "" ? cleanText(b.reasonText, 1000) : null;
    if (typeof b.reasonText === "string" && b.reasonText.trim() !== "" && !extra) bad("reasonText", "too_long");
    if (kind === "other" && !extra) bad("reasonText", "required");
    if (REASON_KINDS.includes(kind as ReasonKind)) {
      answers.reason_kind = kind;
      // the type's own "reason" is words: what the parent chose, and what they added
      const lead = kind === "over_topup" ? "Over top-up" : "Other";
      answers.reason = extra ? `${lead}: ${extra}` : lead;
    }
    if (typeof b.transactionRefs === "string" && b.transactionRefs.trim() !== "") {
      const refs = cleanText(b.transactionRefs, 1000);
      if (!refs) bad("transactionRefs", "too_long");
      else answers.transaction_refs = refs;
    }
  }

  // the refund account (both forms)
  const bank = chosenBank(b.bankChoice, b.bankOther, rules.banks);
  if (!bank) bad(b.bankChoice === "__other__" ? "bankOther" : "bankChoice", typeof b.bankChoice === "string" && b.bankChoice !== "" ? (b.bankChoice === "__other__" ? "required" : "not_a_choice") : "required");
  const number = bankAccountNumber(b.accountNumber);
  if (!number) bad("accountNumber", typeof b.accountNumber === "string" && b.accountNumber.trim() !== "" ? "invalid" : "required");
  const holder = cleanLine(b.accountHolder, 120);
  if (!holder) bad("accountHolder", typeof b.accountHolder === "string" && b.accountHolder.trim().length > 120 ? "too_long" : "required");
  if (bank) answers.bank_name = bank;
  if (number) answers.bank_account_number = number;
  if (holder) answers.bank_account_holder = holder;

  if (!yes(b.declaration)) bad("declaration", "must_acknowledge");
  answers.declaration = yes(b.declaration);

  if (Object.keys(problems).length > 0 || !name || (phone === null && !rules.phoneFromCase)) return { ok: false, problems };
  return { ok: true, value: { type, name, phone: phone ?? "", answers, needsLetter: needsAuthorizationLetter(name, holder ?? "") } };
}

// ---- the files --------------------------------------------------------------------------------------------------------

export const PUBLIC_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The multipart post as a whole: the payload and at most two files. */
export const PUBLIC_MAX_BODY_BYTES = 2 * PUBLIC_MAX_FILE_BYTES + 200_000;

/** Which file fields a form takes: the letter always, the proof on a withdrawal. */
export const fileFieldsFor = (type: PublicType): { id: "letter" | "proof"; fieldKey: "authorization_letter" | "proof" }[] =>
  type === "withdrawal" ? [{ id: "letter", fieldKey: "authorization_letter" }, { id: "proof", fieldKey: "proof" }] : [{ id: "letter", fieldKey: "authorization_letter" }];
