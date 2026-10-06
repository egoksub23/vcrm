// ============================================================
// Doc Sign forms: what the routes say, as types the screens and the services both use. See
// docs/vircle-sign-plan.md section 8. Nothing here has behaviour.
// ============================================================

import type { Issue } from "../rules";
import type { FitProblem } from "./printing";
import type { DataField, FileSummary, FormDefinition, FormValueView, L10n, PartProgress, SignerFormView } from "./types";

export type { SignerFormView, PartProgress, FitProblem, FileSummary };

/** One rejected answer: the data field, why (a stable code the screen words) and a number or limit to show. */
export interface RejectedAnswer {
  field: string;
  code: string;
  detail?: string;
}

/** PUT /api/sign/public/[token]/answers — body `{ answers, confirmParts? }`, answer `SaveAnswersResult`. */
export interface SaveAnswersResult {
  saved: string[];
  rejected: RejectedAnswer[];
  /** Only for a document with a form: where each of this signer's parts stands now. */
  progress?: PartProgress[];
  /** Only for a document with a form: the sign step may open. */
  ready?: boolean;
  /** Keys of answers that came from the contact and are still unconfirmed by the signer. */
  unconfirmed?: string[];
}

/** POST /api/sign/public/[token]/upload (multipart `field`, `file`) — answer `UploadResult`. */
export interface UploadResult {
  file: FileSummary;
  progress: PartProgress[];
  ready: boolean;
}

/** DELETE /api/sign/public/[token]/upload?field=&id= — answer `RemoveUploadResult`. */
export interface RemoveUploadResult {
  progress: PartProgress[];
  ready: boolean;
}

/** What a bound placement draws on the page, for the signer's review (text and ticks; pictures are not previewed). */
export interface PrintedValue {
  text?: string;
  checked?: boolean;
}

/**
 * GET /api/sign/public/[token]/review — the answers as they will be printed, and any answer too long for the place
 * it prints. Only meaningful once every required field is answered. A fit problem blocks signing until the
 * signer shortens the named answer.
 */
export interface ReviewResult {
  printed: Record<string, PrintedValue>;
  fitProblems: FitProblem[];
}

// ---- the sender's view ------------------------------------------------------------------------------------------

export interface StaffAnswerRow {
  key: string;
  type: DataField["type"];
  part: string;
  label: L10n;
  /** The role that completes the part. */
  role: string;
  /** A sensitive answer arrives masked (`•••• 1234`); the value itself comes only from the reveal route. */
  value: FormValueView | null;
  /** True for a field the form marks sensitive: the value is a mask and the screen offers "Reveal". */
  sensitive?: boolean;
  /** `contact` while it is a value from the contact the signer has not confirmed; otherwise `signer`. */
  source: "signer" | "contact" | "sender" | "forwarded";
  savedAt: string | null;
}

export interface StaffRoleProgress {
  roleKey: string;
  roleLabel: string;
  signer: { id: string; name: string; email: string; status: string } | null;
  parts: (PartProgress & { title: L10n })[];
  /** 0 to 100, of required answers given. */
  percent: number;
  lastActivityAt: string | null;
  /** Parts this person handed to someone else (migration 166): who holds each and whether they have completed it. */
  delegations?: { part: string; name: string; done: boolean }[];
}

/** GET /api/sign/documents/[id]/progress (menu.sign) — a document with a form, seen by the sender. */
export interface StaffProgress {
  form: FormDefinition;
  roles: StaffRoleProgress[];
  /** Answers so far, read only. Hidden fields are left out; files show their names and sizes, never their contents. */
  answers: StaffAnswerRow[];
  lastActivityAt: string | null;
  /** Problems the sender should know (an answer too long for where it prints, for instance). */
  issues: Issue[];
}

/** POST /api/sign/documents/[id]/sensitive (sign.send) — body `{ field }`; answer `{ field, value }`. Writes a `sensitive_viewed` event first. */
export interface RevealSensitiveResult {
  field: string;
  value: FormValueView;
}

/** POST /api/sign/documents/[id]/expiry (sign.send) — body `{ expiresAt }` an ISO time in the future; answer `{ expiresAt }`. */
export interface ExtendExpiryResult {
  expiresAt: string;
}

/** POST /api/sign/templates/[id]/versions — body gains `form?`, answer gains `warnings`. */
export interface VersionWarning {
  /** `static_text_does_not_fit` and the like. */
  code: string;
  field?: string;
}
