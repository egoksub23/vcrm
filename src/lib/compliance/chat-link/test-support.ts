// Shared by the closure form link tests only (migration 185): the five database functions as an in-memory stand-in on FakeDb, and the account change fields as
// the migration leaves them. The stand-in follows the SQL step by step (supabase/migrations/185_compliance_chat_link.sql); the SQL itself is proved by
// supabase/ci/verify-185-compliance-chat-link.sql (it ran in PGlite, with mutations, and is to be run rolled back against production).

import { randomUUID } from "node:crypto";

import { FakeDb } from "@/lib/sign/service/fake-db";

import { L } from "../test-support";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null };

const fail = (message: string, code = "23514"): Result => ({ data: null, error: { message, code } });
const EDITABLE = ["received", "identity_check", "officer_review"];
const iso = (ms: number): string => new Date(ms).toISOString();

export interface LinkRpcOptions {
  /** The people who may mint, send and revoke (compliance.raise, review or approve). Default: nobody is refused. */
  allowed?: ReadonlySet<string>;
  now?: () => number;
}

/** Install the five functions on `db`. */
export function installLinkRpc(db: FakeDb, opts: LinkRpcOptions = {}): void {
  const now = opts.now ?? Date.now;
  // the tables exist (rows() hands out a fresh empty list for one that does not)
  for (const t of ["compliance_form_links", "compliance_request_events", "compliance_requests"]) db.tables[t] ??= [];
  const may = (actor: unknown): boolean => !opts.allowed || opts.allowed.has(String(actor));
  const event = (accountId: unknown, requestId: unknown, actor: unknown, kind: string, detail: Row) => {
    db.rows("compliance_request_events").push({ id: randomUUID(), seq: db.rows("compliance_request_events").length + 1, account_id: accountId, request_id: requestId, actor: actor ?? null, kind, detail, at: iso(now()) });
  };
  const links = () => db.rows("compliance_form_links");
  const request = (id: unknown) => db.rows("compliance_requests").find((r) => r.id === id);
  const active = (l: Row) => !l.revoked_at && !l.submitted_at;

  db.uniques.compliance_form_links = [["token_hash"]];

  db.rpcHandlers.compliance_mint_form_link = (a): Result => {
    const r = request(a.p_request);
    if (!r) return fail("compliance_request_not_found", "P0002");
    if (!may(a.p_actor)) return fail("compliance_not_allowed: raise", "42501");
    if (r.type_key !== "closure" || !EDITABLE.includes(String(r.status))) return fail("compliance_form_link_not_allowed");
    if (links().some((l) => l.request_id === r.id && l.submitted_at)) return fail("compliance_form_link_submitted");
    if (typeof a.p_token_hash !== "string" || !/^[0-9a-f]{64}$/.test(a.p_token_hash)) return fail("compliance_bad_patch", "22023");
    if (links().some((l) => l.token_hash === a.p_token_hash)) return fail("duplicate key value violates unique constraint", "23505");
    const days = Math.min(30, Math.max(1, Number(a.p_ttl_days ?? 14)));
    const replaced: string[] = [];
    for (const l of links().filter((x) => x.request_id === r.id && active(x))) {
      l.revoked_at = iso(now());
      l.revoked_by = a.p_actor;
      l.revoked_reason = "replaced";
      replaced.push(String(l.id));
      event(r.account_id, r.id, a.p_actor, "form_link", { action: "revoked", reason: "replaced", link: l.id });
    }
    const expires = iso(now() + days * 86_400_000);
    links().push({
      id: a.p_link,
      account_id: r.account_id,
      request_id: r.id,
      token_hash: a.p_token_hash,
      conversation_id: a.p_conversation ?? null,
      channel: a.p_channel ?? null,
      message_id: null,
      locale: a.p_locale ?? null,
      created_by: a.p_actor,
      created_at: iso(now()),
      expires_at: expires,
      sent_at: null,
      opened_at: null,
      submitted_at: null,
      revoked_at: null,
      revoked_by: null,
      revoked_reason: null,
    });
    event(r.account_id, r.id, a.p_actor, "form_link", { action: "minted", link: a.p_link, channel: a.p_channel ?? null, expires_at: expires });
    return { data: { id: a.p_link, expires_at: expires, replaced }, error: null };
  };

  db.rpcHandlers.compliance_form_link_sent = (a): Result => {
    const l = links().find((x) => x.id === a.p_link);
    if (!l) return fail("compliance_form_link_not_found", "P0002");
    if (!may(a.p_actor)) return fail("compliance_not_allowed: raise", "42501");
    if (!active(l)) return fail("compliance_form_link_not_allowed");
    const reasons = ["window_expired", "channel_unsupported", "send_failed", "no_channel", "not_configured"];
    if (a.p_delivered) l.sent_at = iso(now());
    if (a.p_message) l.message_id = a.p_message;
    event(l.account_id, l.request_id, a.p_actor, "form_link", {
      action: a.p_delivered && a.p_resend ? "resent" : a.p_delivered ? "sent" : "not_sent",
      link: l.id,
      channel: l.channel,
      reason: reasons.includes(String(a.p_reason)) ? a.p_reason : null,
    });
    return { data: true, error: null };
  };

  db.rpcHandlers.compliance_revoke_form_link = (a): Result => {
    const r = request(a.p_request);
    if (!r) return fail("compliance_request_not_found", "P0002");
    if (!may(a.p_actor)) return fail("compliance_not_allowed: raise", "42501");
    const l = links().find((x) => x.request_id === r.id && active(x));
    if (!l) return { data: null, error: null };
    l.revoked_at = iso(now());
    l.revoked_by = a.p_actor;
    l.revoked_reason = "revoked";
    event(r.account_id, r.id, a.p_actor, "form_link", { action: "revoked", reason: "revoked", link: l.id });
    return { data: l.id, error: null };
  };

  db.rpcHandlers.compliance_form_link_opened = (a): Result => {
    const l = links().find((x) => x.id === a.p_link);
    if (!l || !active(l) || Date.parse(String(l.expires_at)) <= now()) return { data: false, error: null };
    if (!l.opened_at) {
      l.opened_at = iso(now());
      event(l.account_id, l.request_id, null, "form_link", { action: "opened", link: l.id, channel: l.channel });
    }
    return { data: true, error: null };
  };

  db.rpcHandlers.compliance_apply_form_link = (a): Result => {
    const l = links().find((x) => x.id === a.p_link);
    if (!l || !active(l) || Date.parse(String(l.expires_at)) <= now()) return fail("compliance_form_link_invalid");
    const r = request(l.request_id);
    if (!r || r.type_key !== "closure" || !EDITABLE.includes(String(r.status))) return fail("compliance_form_link_invalid");
    const name = String(a.p_name ?? "").trim();
    const email = String(a.p_email ?? "").trim();
    if (!name || name.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !a.p_data || typeof a.p_data !== "object" || Array.isArray(a.p_data)) return fail("compliance_bad_patch", "22023");
    r.customer_name = name;
    r.customer_email = email;
    r.customer_phone = r.customer_phone ?? (typeof a.p_phone === "string" && a.p_phone.trim() ? a.p_phone.trim() : null);
    r.data = { ...((r.data as Row | null) ?? {}), ...(a.p_data as Row) };
    r.data_enc = a.p_data_enc ?? r.data_enc;
    r.customer_locale = a.p_locale ?? r.customer_locale ?? null;
    l.submitted_at = iso(now());
    event(r.account_id, r.id, null, "form_submitted", { link: l.id, channel: l.channel });
    return { data: { request_id: r.id, reference: r.reference, account_id: r.account_id, created_by: l.created_by, conversation_id: l.conversation_id, contact_id: r.contact_id, phone_known: r.customer_phone !== null }, error: null };
  };
}

/** The account change type's fields as migration 185 leaves them (what_changes first, the pairs asked by choice). */
export const ACCOUNT_CHANGE_FIELDS = [
  {
    key: "what_changes",
    type: "choice",
    required: true,
    sensitive: false,
    label: L("What is changing"),
    help: L("A parent's name cannot be changed here."),
    options: [
      { value: "parent_phone", label: L("Parent phone number") },
      { value: "parent_email", label: L("Parent email address") },
      { value: "child_name", label: L("Child's name") },
    ],
  },
  { key: "current_phone", type: "phone", required: true, sensitive: false, label: L("Current phone number"), showIf: { field: "what_changes", in: ["parent_phone"] } },
  { key: "new_phone", type: "phone", required: true, sensitive: false, label: L("New phone number"), showIf: { field: "what_changes", in: ["parent_phone"] } },
  { key: "current_email", type: "email", required: true, sensitive: false, label: L("Current email address"), showIf: { field: "what_changes", in: ["parent_email"] } },
  { key: "new_email", type: "email", required: true, sensitive: false, label: L("New email address"), showIf: { field: "what_changes", in: ["parent_email"] } },
  { key: "child_current_name", type: "text", required: true, sensitive: false, label: L("Child's current name"), showIf: { field: "what_changes", in: ["child_name"] } },
  { key: "child_new_name", type: "text", required: true, sensitive: false, label: L("Child's new name"), showIf: { field: "what_changes", in: ["child_name"] } },
];

/** Switch the standard phone_change type of a `world()` over to Account change. */
export function useAccountChange(db: FakeDb): void {
  const t = (db.rows("compliance_request_types") as Row[]).find((x) => x.key === "phone_change");
  if (t) {
    t.fields = ACCOUNT_CHANGE_FIELDS;
    t.label = "Account change";
    t.label_l10n = { ms: "Pertukaran maklumat akaun", zh: "账户信息变更", ko: "계정 정보 변경" };
  }
}
