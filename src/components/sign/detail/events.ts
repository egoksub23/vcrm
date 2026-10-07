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
  /** Who a person was when the event happened (a turn that was forwarded keeps the forwarder's name on what the forwarder did). */
  nameAt?: (signerId: string | null, at: string) => string | null;
  /** Forms: the title of a part of the document's form in the reader's language, or null when it is not known. */
  partTitle?: (partKey: string) => string | null;
  /** Forms: the label of a data field of the form, or null. */
  fieldLabel?: (fieldKey: string) => string | null;
  /** Forms: the document's contact (the write-back's line links to it). */
  contactId?: string | null;
  /** Forms: a day in the reader's language and time zone (the new expiry). */
  formatDay?: (iso: string) => string;
  /** `form` for a form without a signature (migration 169): the history says "submitted" and "the form", never "signed". */
  mode?: string | null;
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
  /** Message key under the namespace `ns`. */
  key: string;
  /** Which messages the key is in: `Sign.detail` (the first phase) or `Sign.progress` (events of a form). */
  ns: "detail" | "progress";
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
  /** Forms (write-back): the contact fields that changed, as stored ("name", "email", "custom:Branch"); never their values. */
  contactFields: string[];
  /** Something the line can link to (the contact whose record the answers updated). */
  link: { kind: "contact"; id: string } | null;
}

const KNOWN: ReadonlySet<string> = new Set<EventType>(EVENT_TYPES);
/** The events a form without a signature words differently (`events.<type>Form`). */
const FORM_WORDED: ReadonlySet<string> = new Set(["created", "sent", "viewed", "consented", "submitted", "declined", "sealed", "completed", "downloaded"]);
const FAILURES: ReadonlySet<string> = new Set(["delivery_failed", "code_failed", "seal_failed", "seal_attempt_failed"]);
const MINOR: ReadonlySet<string> = new Set(["saved"]);
/** Events of a form: worded under `Sign.progress.events`. */
const FORM_EVENTS: ReadonlySet<string> = new Set(["part_completed", "part_reopened", "uploaded", "upload_removed", "writeback", "expiry_extended"]);

const text = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

const firstText = (...values: unknown[]): string | null => {
  for (const v of values) {
    const t = text(v, 300);
    if (t) return t;
  }
  return null;
};

/** The contact fields a write-back names, from `fields` or `changes` (names only: the values stay in the audit chain). */
function writebackFields(detail: Record<string, unknown>): string[] {
  // One event per contact field changed carries `field`; a combined event may carry `fields` or `changes`.
  const list = Array.isArray(detail.fields) ? detail.fields : Array.isArray(detail.changes) ? detail.changes : detail.field !== undefined ? [detail.field] : [];
  const names = list
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? firstText((x as Record<string, unknown>).contactField, (x as Record<string, unknown>).contact_field, (x as Record<string, unknown>).field) : null))
    .filter((x): x is string => !!x && x.trim() !== "");
  return [...new Set(names)];
}

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
  const signerName = ctx.nameAt?.(row.signer_id, row.created_at) ?? signer?.full_name ?? null;
  const actor = signerName ?? ctx.someone;
  const sender = person ?? ctx.teammate;
  const values: Record<string, string> = { actor, sender, type: row.type };

  let key = KNOWN.has(row.type) ? `events.${row.type}` : "events.unknown";
  // a form without a signature: the same event in its own words (the database also marks `sent` and `consented` with `mode`)
  if (FORM_WORDED.has(row.type) && (ctx.mode === "form" || ((row.type === "sent" || row.type === "consented") && detail.mode === "form"))) key = `events.${row.type}Form`;
  if (row.type === "invited" && detail.because === "step_finished") {
    // a step with several people: invited because the whole previous step finished
    key = "events.invitedAfterStep";
  } else if (row.type === "invited" && detail.because === "signer_finished" && text(detail.finished_name, 160)) {
    key = "events.invitedAfter";
    values.previous = text(detail.finished_name, 160) as string;
  } else if (row.type === "invited" && ctx.signInOrder) {
    const before = previousSigner(ctx.signers, row.signer_id);
    if (before) {
      key = "events.invitedAfter";
      values.previous = before.full_name;
    }
  } else if (row.type === "forwarded" || row.type === "part_forwarded" || row.type === "part_taken_back") {
    // forwarding (migration 166): names only; the address in the detail is masked and not worded here
    values.from = text(detail.from_name, 160) ?? actor;
    values.to = text(detail.to_name, 160) ?? ctx.someone;
    const partKey = text(detail.part, 80);
    values.part = partKey ? (ctx.partTitle?.(partKey) ?? partKey) : "";
  } else if (row.type === "envelope_sent" || row.type === "envelope_completed" || row.type === "envelope_declined" || row.type === "envelope_document_added" || row.type === "envelope_document_removed" || row.type === "envelope_reordered") {
    // an envelope (migration 171): its reference and size, and who declined it; the document's own events are worded as ever.
    // While a draft: the document that was removed (its title), and the new size.
    values.reference = text(detail.reference, 40) ?? "";
    values.title = text(detail.title, 200) ?? "";
    values.count = typeof detail.count === "number" ? String(detail.count) : "";
    values.by = text(detail.by_name, 160) ?? actor;
  } else if (row.type === "copy_recipient_added" || row.type === "copy_recipient_removed") {
    // a person who receives a copy (migration 175): the name and the masked address, never the address itself
    values.name = text(detail.name, 160) ?? ctx.someone;
    values.email = text(detail.email, 200) ?? "";
    values.reference = text(detail.reference, 40) ?? "";
  } else if (row.type === "signer_moved") {
    values.step = typeof detail.to_step === "number" ? String(detail.to_step) : "";
  } else if (row.type === "forwarding_changed") {
    if (typeof detail.allow === "boolean") key = detail.allow ? "events.forwarding_on" : "events.forwarding_off";
  } else if (row.type === "recipient_changed") {
    const from = text(detail.from_email, 200);
    const to = text(detail.to_email, 200);
    if (from && to) {
      key = "events.recipient_changedFromTo";
      values.from = from;
      values.to = to;
    }
  } else if (row.type === "code_verified" && detail.method === "halo_login") {
    // a Halo user who opened their own turn from inside Halo (service/countersign.ts): identified by their sign-in, no code
    key = "events.code_verified_halo";
  } else if (row.type === "delivery_failed" && detail.kind === "completed") {
    // A copy for the sender has no signer on the row.
    key = signer ? "events.delivery_failedCompleted" : "events.delivery_failedCompletedSender";
  }

  // The events of a form. Only what changed is worded, never the values: a write-back's old and new values are in the
  // audit chain for those who need them.
  let link: EventLine["link"] = null;
  let contactFields: string[] = [];
  if (FORM_EVENTS.has(row.type)) {
    const partKey = firstText(detail.part, detail.part_key, detail.partKey);
    const part = partKey ? (ctx.partTitle?.(partKey) ?? partKey) : null;
    const fileName = firstText(detail.name, detail.file_name, detail.filename, detail.file);
    const fieldKey = row.type === "uploaded" || row.type === "upload_removed" ? firstText(detail.field, detail.field_key) : null;
    const field = fieldKey ? (ctx.fieldLabel?.(fieldKey) ?? fieldKey) : null;
    const fields = row.type === "writeback" ? writebackFields(detail) : [];
    contactFields = fields;
    const until = firstText(detail.expires_at, detail.expiresAt, detail.to, detail.until);
    values.part = part ?? "";
    values.hasPart = part ? "yes" : "no";
    values.file = fileName ?? "";
    values.hasFile = fileName ? "yes" : "no";
    values.field = field ?? "";
    values.hasField = field ? "yes" : "no";
    values.fields = fields.join(", ");
    values.hasFields = fields.length ? "yes" : "no";
    const day = until && !Number.isNaN(new Date(until).getTime()) ? (ctx.formatDay?.(until) ?? until.slice(0, 10)) : null;
    values.date = day ?? "";
    values.hasDate = day ? "yes" : "no";
    const contactId = firstText(detail.contact_id, detail.contactId) ?? ctx.contactId ?? null;
    if (row.type === "writeback" && contactId) link = { kind: "contact", id: contactId };
  }

  // a sender revealed a sensitive answer: which field, never what it held (the event carries only the field's key)
  if (row.type === "sensitive_viewed") {
    const fieldKey = firstText(detail.field, detail.field_key);
    const field = fieldKey ? (ctx.fieldLabel?.(fieldKey) ?? fieldKey) : null;
    values.field = field ?? "";
    values.hasField = field ? "yes" : "no";
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
    ns: FORM_EVENTS.has(row.type) ? "progress" : "detail",
    values,
    actorType: row.actor_type,
    actorName: person ?? (row.actor_type === "signer" ? signerName : null),
    failed: FAILURES.has(row.type),
    minor: MINOR.has(row.type),
    reason: row.type === "declined" || row.type === "voided" ? text(detail.reason, 1000) : null,
    details,
    contactFields,
    link,
  };
}

/** The latest time the answers updated the contact, and how many contact fields changed in all; null when they never did. */
export function latestWriteback(rows: readonly Pick<SignEventRow, "type" | "doc_seq" | "created_at">[] | null): { at: string; count: number } | null {
  const all = (rows ?? []).filter((r) => r.type === "writeback").sort((a, b) => b.doc_seq - a.doc_seq);
  return all.length ? { at: all[0].created_at, count: all.length } : null;
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
