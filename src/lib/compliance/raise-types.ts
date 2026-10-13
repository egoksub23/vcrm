// ============================================================
// Compliance requests, raising from the Inbox and from tickets: the shapes the dialog and the status chips share with the server. No I/O and no Node imports,
// so the browser may import this file (the services that fill them are service/raise.ts).
// ============================================================

import type { ChatLinkOutcome, NotSentReason } from "./chat-link/types";
import type { FieldDef, RequestStatus } from "./types";

/** The fields the public form fills for itself (a declaration the customer ticked on the web, the choice behind the reason, a proof upload): not asked of a member of staff. */
export const PUBLIC_ONLY_FIELDS: readonly string[] = ["declaration", "reason_kind", "proof"];

/** The fields a member of staff fills when raising: the type's, without files and without the public form's own helpers. */
export const raiseFieldsOf = (fields: readonly FieldDef[]): FieldDef[] => fields.filter((f) => f.type !== "file" && !PUBLIC_ONLY_FIELDS.includes(f.key));

export interface RaiseContext {
  contact: { id: string; name: string | null; phone: string | null; email: string | null; language: string | null } | null;
  channel: string | null;
  /**
   * Migration 185. Can the account closure form be put in THIS conversation as a tappable card (or the plain line where the channel has no button)? The
   * dialog's "Send the closure form to the customer in this chat" is ticked by default only when it can. `reason` says why not (the 24-hour WhatsApp window
   * is closed, the channel cannot carry it, there is no conversation); the agent still gets the link to copy.
   */
  chatLink: { available: boolean; reason?: NotSentReason };
  types: { key: string; label: string; labelL10n: Partial<Record<"ms" | "zh" | "ko", string>>; fields: FieldDef[] }[];
  /** Types for which this customer already has an open request (a flag only: the reference is not given). */
  open: string[];
}

export interface RaiseResult {
  reference: string;
  status: RequestStatus;
  /** Only for a person who holds a compliance permission: the case, to open it. */
  id?: string;
  notice?: { status: "sent" | "failed" | "skipped" | "duplicate"; detail?: string; language?: string };
  /** Migration 185. What came of the closure form for the chat, when the agent asked for it. Holds the personal address ONLY when it was not sent (Copy link). */
  chatLink?: ChatLinkOutcome;
}

export type RaiserStatus = "received" | "in_review" | "in_progress" | "done" | "not_approved" | "closed";

/** The status words a raiser is shown: a few, plain ones (the case's own nine steps are for the people who handle it). */
export function raiserStatus(status: RequestStatus): RaiserStatus {
  switch (status) {
    case "received":
      return "received";
    case "identity_check":
    case "officer_review":
    case "awaiting_signoff":
      return "in_review";
    case "approved":
    case "executing":
      return "in_progress";
    case "completed":
      return "done";
    case "rejected":
      return "not_approved";
    default:
      return "closed";
  }
}

/** The ONLY thing a raiser gets about a case: its reference, its type, its status and when it was raised. No customer, no answer, no reason. */
export interface RaisedItem {
  reference: string;
  typeKey: string;
  typeLabel: string;
  typeLabelL10n: Partial<Record<"ms" | "zh" | "ko", string>>;
  status: RaiserStatus;
  raisedAt: string;
  /** Only for a person who holds a compliance permission. */
  id?: string;
}

/**
 * Migration 185. A request linked to an Inbox conversation or its contact, as the column shows it: the raiser's projection, plus the case's own step for a
 * person who holds a compliance permission (who also gets the id, to open it). Nobody else gets more than the projection.
 */
export interface LinkedItem extends RaisedItem {
  /** Only for a person who holds a compliance permission. */
  step?: RequestStatus;
}
