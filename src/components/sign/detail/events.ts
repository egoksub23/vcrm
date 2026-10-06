// ============================================================
// Doc Sign, the history of a document: each row of the audit chain turned into one plain sentence (as a
// message key and its values, so the screen words it in the reader's language), put in order, with the
// technical detail kept apart behind a "Details" disclosure. Pure.
// ============================================================

import { EVENT_TYPES, type EventType } from "@/lib/sign/types";

/** A row of `sign_events` as the browser reads it (the hashes stay in the database). */
export interface SignEventRow {
  id: string;
  doc_seq: number;
  signer_id: string | null;
  type: string;
  actor_type: "user" | "signer" | "system";
  actor_user_id: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  device: string | null;
  created_at: string;
}

export const EVENT_COLUMNS = "id, doc_seq, signer_id, type, actor_type, actor_user_id, detail, ip, device, created_at";

export interface EventSigner {
  id: string;
  full_name: string;
  order_no: number;
}

export interface DescribeContext {
  signers: readonly EventSigner[];
  signInOrder: boolean;
  /** The name of a person in the workspace, or null when unknown. */
  userName: (userId: string | null) => string | null;
  /** Used when a name cannot be found (a signer who was replaced, a teammate who left). */
  someone: string;
  teammate: string;
}

export type DetailKind = "ip" | "device" | "consent" | "fingerprint" | "channel" | "delivery" | "error";

export interface EventDetail {
  kind: DetailKind;
  value: string;
}

export interface EventLine {
  id: string;
  seq: number;
  at: string;
  type: string;
  /** Message key under `Sign.detail`. */
  key: string;
  values: Record<string, string>;
  actorType: SignEventRow["actor_type"];
  /** Who did it, when it was a person; null for the system. */
  actorName: string | null;
  /** Something did not go through: flagged with a word, not only a colour. */
  failed: boolean;
  /** Autosaves and the like: hidden unless the reader asks. */
  minor: boolean;
  /** The reason a person gave (declined, cancelled). */
  reason: string | null;
  details: EventDetail[];
}

const KNOWN: ReadonlySet<string> = new Set<EventType>(EVENT_TYPES);
const FAILURES: ReadonlySet<string> = new Set(["delivery_failed", "code_failed", "seal_failed", "seal_attempt_failed"]);
const MINOR: ReadonlySet<string> = new Set(["saved"]);

const text = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** The signer who was invited just before this one, for "invited because X finished". */
function previousSigner(signers: readonly EventSigner[], signerId: string | null): EventSigner | null {
  const me = signers.find((s) => s.id === signerId);
  if (!me) return null;
  const earlier = signers.filter((s) => s.order_no < me.order_no).sort((a, b) => b.order_no - a.order_no);
  return earlier[0] ?? null;
}

export function describeEvent(row: SignEventRow, ctx: DescribeContext): EventLine {
  const detail = row.detail ?? {};
  const signer = ctx.signers.find((s) => s.id === row.signer_id) ?? null;
  const person = row.actor_type === "user" ? ctx.userName(row.actor_user_id) : null;
  const actor = signer?.full_name ?? ctx.someone;
  const sender = person ?? ctx.teammate;
  const values: Record<string, string> = { actor, sender, type: row.type };

  let key = KNOWN.has(row.type) ? `events.${row.type}` : "events.unknown";
  if (row.type === "invited" && ctx.signInOrder) {
    const before = previousSigner(ctx.signers, row.signer_id);
    if (before) {
      key = "events.invitedAfter";
      values.previous = before.full_name;
    }
  } else if (row.type === "recipient_changed") {
    const from = text(detail.from_email, 200);
    const to = text(detail.to_email, 200);
    if (from && to) {
      key = "events.recipient_changedFromTo";
      values.from = from;
      values.to = to;
    }
  } else if (row.type === "delivery_failed" && detail.kind === "completed") {
    // A copy for the sender has no signer on the row.
    key = signer ? "events.delivery_failedCompleted" : "events.delivery_failedCompletedSender";
  }

  const details: EventDetail[] = [];
  const add = (kind: DetailKind, value: string | null) => {
    if (value) details.push({ kind, value });
  };
  add("ip", row.ip);
  add("device", row.device ? row.device.slice(0, 300) : null);
  if (row.type === "consented") add("consent", text(detail.version, 60));
  if (row.type === "sent") add("fingerprint", text(detail.base_sha256, 80));
  if (row.type === "sealed") add("fingerprint", text(detail.final_sha256, 80));
  if (row.type === "delivery_failed") {
    add("channel", text(detail.channel, 20));
    add("delivery", text(detail.reason, 300));
  }
  if (row.type === "seal_attempt_failed") add("error", text(detail.error, 300));

  return {
    id: row.id,
    seq: row.doc_seq,
    at: row.created_at,
    type: row.type,
    key,
    values,
    actorType: row.actor_type,
    actorName: person ?? (row.actor_type === "signer" ? signer?.full_name ?? null : null),
    failed: FAILURES.has(row.type),
    minor: MINOR.has(row.type),
    reason: row.type === "declined" || row.type === "voided" ? text(detail.reason, 1000) : null,
    details,
  };
}

/** The history in the order the reader wants it; the chain's own sequence number decides, then time. */
export function orderEvents<T extends { doc_seq: number; created_at: string; id: string }>(rows: readonly T[], newestFirst: boolean): T[] {
  const sorted = [...rows].sort((a, b) => a.doc_seq - b.doc_seq || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return newestFirst ? sorted.reverse() : sorted;
}

/** The detail shown behind "Details": technical items only for people who may see them. */
export function visibleDetails(line: Pick<EventLine, "details">, technical: boolean): EventDetail[] {
  return line.details.filter((d) => technical || d.kind !== "error");
}

// ---- the chain check -----------------------------------------------------------------------

export type ChainState = { state: "intact"; events: number } | { state: "broken"; at: number | null } | { state: "unknown" };

/** Read the answer of `sign_verify_chain`: {"ok": true, "events": n, ...} or {"ok": false, "broken_at": seq}. */
export function chainState(result: unknown): ChainState {
  if (!result || typeof result !== "object") return { state: "unknown" };
  const r = result as { ok?: unknown; events?: unknown; broken_at?: unknown };
  if (r.ok === true) return { state: "intact", events: typeof r.events === "number" ? r.events : 0 };
  if (r.ok === false) return { state: "broken", at: typeof r.broken_at === "number" ? r.broken_at : null };
  return { state: "unknown" };
}
