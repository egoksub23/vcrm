// ============================================================
// KYC review: the shapes the server sends to the screen. Pure types, no imports, so a client component can use them.
//
// Everything here has already been through the adapter (adapter.ts) ON THE SERVER: values of sensitive fields are masked before they are put in
// a ValidationView, so the browser never holds more than the reviewer is allowed to see. The vendor's own field names are PROVISIONAL (the back
// end's Postman collection has no example responses); the adapter is the one place that guesses them.
// ============================================================

export type StatusTone = "positive" | "pending" | "negative" | "neutral";

/** One labelled value of a validation. */
export interface KycField {
  /** The vendor's key, as sent (a dotted path for a nested value), or the adapter's name for a known field. */
  key: string;
  /** Human label for a known field ("ID number"); null for a generic one (the screen shows the key). */
  label: string | null;
  /**
   * The value to show. For a sensitive field that is not revealed: a partly masked string ("S1••••••34") or null (= fully hidden, the screen
   * writes "Hidden"). Never the real value in that case.
   */
  value: string | null;
  /** The adapter treats this field as sensitive (masked until a reviewer with kyc.reveal presses Reveal). */
  sensitive: boolean;
  /** `sensitive` and the value shown is masked. */
  masked: boolean;
}

export interface KycValidation {
  /** The vendor's id for the validation, as a string. Empty when the response had none (then no image can be opened). */
  id: string;
  /** The id can be used in the image route (it matches the allowed characters). */
  idUsable: boolean;
  friendId: string | null;
  /** "NRIC", "PASSPORT" ... as the vendor sent it (upper-cased when short), or null. */
  type: string | null;
  status: { raw: string | null; tone: StatusTone };
  /** ISO 8601 (UTC) when the vendor's timestamp could be read, else null. */
  createdAt: string | null;
  createdAtRaw: string | null;
  updatedAt: string | null;
  /** Confidence or score, ready to show ("93%", "0.87"), or null. */
  score: string | null;
  /** The vendor's reason or message, or null. */
  reason: string | null;
  /** Known fields, in a fixed order (name, ID number, date of birth, address, ...). */
  known: KycField[];
  /** Every other scalar field the response carried, in the vendor's order. */
  extra: KycField[];
  /** Fields that were not sent to the browser at all (links, storage paths, tokens, very long values): how many. */
  withheld: number;
  /** True when no known field except the id was found: the field names are probably different from the adapter's guesses. */
  fallback: boolean;
  /** At least one field is masked in this view (so Reveal would show more). */
  hasMasked: boolean;
}

export interface KycValidationList {
  friendId: string;
  items: KycValidation[];
  /** True when `reveal` was honoured for one validation (the one named in `revealedId`). */
  revealedId: string | null;
  /** True when any item fell back to the generic table (field names provisional). */
  fallback: boolean;
}

export type KycErrorCode =
  | "not_configured"
  | "upstream_unreachable"
  | "upstream_unauthorized"
  | "not_found"
  | "bad_response"
  | "image_too_large"
  | "image_type_unsupported"
  | "image_host_blocked"
  | "invalid_request"
  | "rate_limited"
  | "forbidden"
  /** The access log could not be written, so nothing was shown (the log is never skipped). */
  | "audit_failed";

export interface KycStatus {
  configured: boolean;
  /** The configured base URL is the UAT host (the screen shows a banner). */
  uat: boolean;
  /** Names of the missing environment variables. Only sent to admins; an empty list for everyone else. */
  missing: string[];
  canView: boolean;
  canReveal: boolean;
  /** An admin or owner: sees the access log tab and the setup hints. */
  isAdmin: boolean;
}

export interface KycAccessRow {
  id: string;
  createdAt: string;
  userId: string | null;
  userName: string | null;
  action: "lookup" | "list" | "view_image" | "reveal" | "config_error";
  friendId: string | null;
  validationId: string | null;
  outcome: "ok" | "not_found" | "forbidden" | "error";
}

export const KYC_ACTIONS = ["lookup", "list", "view_image", "reveal", "config_error"] as const;
export const KYC_OUTCOMES = ["ok", "not_found", "forbidden", "error"] as const;

/** Characters a friend id may hold, and its length. The same rule is applied by the route and the screen. */
export const FRIEND_ID_RE = /^[A-Za-z0-9._@:+-]{1,100}$/;
/** Characters a validation id may hold (it goes into a vendor path, so nothing else is let through). It must start with a letter or digit, so `.` and `..` can never walk the path. */
export const VALIDATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;

export function normaliseFriendId(raw: string): string {
  return raw.trim();
}
