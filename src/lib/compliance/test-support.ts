// Shared by the Compliance requests tests only: a workspace in the in-memory database (FakeDb), the three system types as migration 183 seeds them, people
// with permissions, and the pieces of a case. Nothing here touches the network or a real database; the rules that live in SQL are proved by
// supabase/ci/verify-183-compliance-requests.sql, not here.

import { FakeDb } from "@/lib/sign/service/fake-db";

import type { ComplianceCaller, TypeDbRow } from "./service/rows";
import type { Viewer } from "./types";

export const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
export const OTHER_ACCOUNT = "a0000000-0000-4000-8000-000000000002";

export const OFFICER = "11111111-1111-4111-8111-111111111111";
export const HEAD = "22222222-2222-4222-8222-222222222222";
export const OPS = "33333333-3333-4333-8333-333333333333";
export const AGENT = "44444444-4444-4444-8444-444444444444";
export const OUTSIDER = "55555555-5555-4555-8555-555555555555";

export const L = (en: string) => ({ en, ms: `${en} (ms)`, zh: `${en} (zh)`, ko: `${en} (ko)` });

export const CLOSURE_FIELDS = [
  { key: "confirm_closure", type: "acknowledge", required: true, sensitive: false, label: L("I confirm I want to close this account") },
  { key: "children_finished_school", type: "acknowledge", required: true, sensitive: false, label: L("Every child has finished school") },
  { key: "allowances_cancelled", type: "acknowledge", required: true, sensitive: false, label: L("Every allowance has been cancelled") },
  { key: "reason", type: "multiline", required: false, sensitive: false, label: L("Reason") },
  { key: "bank_name", type: "text", required: true, sensitive: true, label: L("Bank name") },
  { key: "bank_account_number", type: "text", required: true, sensitive: true, label: L("Bank account number") },
  { key: "bank_account_holder", type: "text", required: true, sensitive: true, label: L("Bank account holder name") },
  { key: "authorization_letter", type: "file", required: false, sensitive: false, label: L("Authorization letter") },
];

export const TYPE_ROWS: TypeDbRow[] = [
  {
    id: "t-closure",
    key: "closure",
    label: "Account closure",
    label_l10n: { ms: "Penutupan akaun", zh: "关闭账户", ko: "계정 해지" },
    fields: CLOSURE_FIELDS,
    checklist: [
      { key: "close_in_backoffice", label: L("Close the account in the back office") },
      { key: "refund", label: L("Refund the balance") },
      { key: "confirm_customer", label: L("Tell the customer it is done") },
    ],
    target_days: 14,
    hard_stop_days: 30,
    requires_identity_check: true,
    check_dues: true,
    allow_pause: false,
    active: true,
    is_system: true,
    position: 1,
  },
  {
    id: "t-withdrawal",
    key: "withdrawal",
    label: "Fund withdrawal",
    label_l10n: {},
    fields: [
      { key: "amount", type: "number", required: true, sensitive: false, label: L("Amount") },
      { key: "reason", type: "multiline", required: true, sensitive: false, label: L("Reason") },
      { key: "bank_account_number", type: "text", required: true, sensitive: true, label: L("Bank account number") },
    ],
    checklist: [{ key: "transfer", label: L("Transfer the amount") }],
    target_days: null,
    hard_stop_days: null,
    requires_identity_check: true,
    check_dues: false,
    allow_pause: false,
    active: true,
    is_system: true,
    position: 2,
  },
  {
    id: "t-phone",
    key: "phone_change",
    label: "Phone number change",
    label_l10n: {},
    fields: [
      { key: "current_phone", type: "phone", required: true, sensitive: false, label: L("Current phone number") },
      { key: "new_phone", type: "phone", required: true, sensitive: false, label: L("New phone number") },
    ],
    checklist: [],
    target_days: null,
    hard_stop_days: null,
    requires_identity_check: true,
    check_dues: false,
    allow_pause: false,
    active: true,
    is_system: true,
    position: 3,
  },
];

export const caps = (...c: string[]): Set<string> => new Set(c);

export function viewerFor(userId: string, held: Iterable<string>): Viewer {
  const s = new Set(held);
  return {
    userId,
    canReview: s.has("compliance.review"),
    canApprove: s.has("compliance.approve"),
    canReveal: s.has("compliance.reveal"),
    canExecute: s.has("compliance.execute"),
    canManage: s.has("compliance.manage"),
  };
}

export const callerFor = (userId: string, held: Iterable<string>, accountId = ACCOUNT): ComplianceCaller => ({ accountId, userId, viewer: viewerFor(userId, held) });

export const ALL = ["compliance.review", "compliance.approve", "compliance.reveal", "compliance.execute", "compliance.manage"];
export const officer = (): ComplianceCaller => callerFor(OFFICER, ["compliance.review"]);
export const head = (): ComplianceCaller => callerFor(HEAD, ["compliance.review", "compliance.approve", "compliance.reveal"]);
export const ops = (): ComplianceCaller => callerFor(OPS, ["compliance.execute"]);

/** A workspace with its three types and a few people, and what the database fills in for a new case or event. */
export function world(): FakeDb {
  const db = new FakeDb();
  let n = 0;
  let seq = 0;
  db.seed("compliance_request_types", TYPE_ROWS.map((t) => ({ ...t, account_id: ACCOUNT })));
  db.seed("profiles", [
    { user_id: OFFICER, account_id: ACCOUNT, full_name: "Olivia Officer", email: "olivia@example.test" },
    { user_id: HEAD, account_id: ACCOUNT, full_name: "Harun Head", email: "harun@example.test" },
    { user_id: OPS, account_id: ACCOUNT, full_name: "Omar Ops", email: "omar@example.test" },
    { user_id: AGENT, account_id: ACCOUNT, full_name: "Alia Agent", email: "alia@example.test" },
    { user_id: OUTSIDER, account_id: OTHER_ACCOUNT, full_name: "Ola Outsider", email: "ola@example.test" },
  ]);
  db.insertDefaults.compliance_requests = (given) => {
    const received = (given.received_at as string | undefined) ?? new Date().toISOString();
    return {
      reference: `CMP-2026-${String(++n).padStart(6, "0")}`,
      status: "received",
      received_at: received,
      identity_check: {},
      review: {},
      signoff: {},
      account_standing: {},
      paused_total_seconds: 0,
      clock_alert_level: 0,
      retention_until: new Date(Date.parse(received) + 7 * 365 * 86_400_000).toISOString(),
      is_test: false,
      data: {},
    };
  };
  db.insertDefaults.compliance_request_events = () => ({ seq: ++seq, at: new Date().toISOString() });
  // holders of a capability: the people the test names (the real function reads the roles)
  db.rpcHandlers.compliance_holders = (args) => ({
    data: args.p_cap === "menu.compliance" ? [OFFICER, HEAD, OPS] : [HEAD],
    error: null,
  });
  return db;
}

export const eventsOf = (db: FakeDb, requestId: string) => db.rows("compliance_request_events").filter((e) => e.request_id === requestId);

/** A made-up bank account number. Tests search every row, event and answer for it. */
export const ACCOUNT_NUMBER = "8800123456789012";
export const BANK_NAME = "Maybank Berhad";
export const HOLDER = "Siti Aminah binti Yusof";

export const CLOSURE_ANSWERS = {
  confirm_closure: true,
  children_finished_school: true,
  allowances_cancelled: true,
  reason: "Moving abroad",
  bank_name: BANK_NAME,
  bank_account_number: ACCOUNT_NUMBER,
  bank_account_holder: HOLDER,
};

// ---- Part B (migration 184): the public parent forms ----------------------------------------------------------------------------------------------

const DECLARATION = { key: "declaration", type: "acknowledge", required: false, sensitive: false, label: L("I declare that the details are true") };
const BANK = [
  { key: "bank_name", type: "text", required: true, sensitive: true, label: L("Bank name") },
  { key: "bank_account_number", type: "text", required: true, sensitive: true, label: L("Bank account number") },
  { key: "bank_account_holder", type: "text", required: true, sensitive: true, label: L("Bank account holder name") },
];
const LETTER = { key: "authorization_letter", type: "file", required: false, sensitive: false, label: L("Authorization letter") };

/** The closure type as migration 184 leaves it: the standard fields plus the declaration. */
export const CLOSURE_FIELDS_184 = [...CLOSURE_FIELDS, DECLARATION];

/** The withdrawal type as migrations 183 and 184 leave it. */
export const WITHDRAWAL_FIELDS_184 = [
  { key: "amount", type: "number", required: true, sensitive: false, label: L("Amount") },
  { key: "reason", type: "multiline", required: true, sensitive: false, label: L("Reason") },
  { key: "transaction_refs", type: "multiline", required: false, sensitive: false, label: L("Transaction references") },
  ...BANK,
  LETTER,
  { key: "reason_kind", type: "choice", required: false, sensitive: false, label: L("Why"), options: [{ value: "over_topup", label: L("Over top-up") }, { value: "other", label: L("Other") }] },
  DECLARATION,
  { key: "proof", type: "file", required: false, sensitive: false, label: L("Proof") },
];

export const FORM_CLOSURE = "f0000000-0000-4000-8000-0000000000c1";
export const FORM_WITHDRAWAL = "f0000000-0000-4000-8000-0000000000d1";
export const SLUG_CLOSURE = "close-account-abc23456";
export const SLUG_WITHDRAWAL = "withdraw-funds-xyz23456";

/** `world()` with the compliance flag on, the two types carrying the public form's fields, and both public forms switched on. */
export function publicWorld(): FakeDb {
  const db = world();
  const types = db.rows("compliance_request_types") as Record<string, unknown>[];
  for (const t of types) {
    if (t.key === "closure") t.fields = CLOSURE_FIELDS_184;
    if (t.key === "withdrawal") t.fields = WITHDRAWAL_FIELDS_184;
  }
  // the unique constraints migration 184 adds
  db.uniques.compliance_notices = [["request_id", "kind", "key"]];
  // the database stamps the clock from the type when a case is made
  const base = db.insertDefaults.compliance_requests;
  db.insertDefaults.compliance_requests = (given) => ({ ...base(given), target_days: given.type_key === "closure" ? 14 : null, hard_stop_days: given.type_key === "closure" ? 30 : null });
  db.seed("accounts", [{ id: ACCOUNT, name: "Vircle", brand_name: null, brand_logo_url: null, locale: "en" }]);
  db.seed("account_platform", [{ account_id: ACCOUNT, status: "active", features: { compliance: true } }]);
  db.seed("compliance_public_forms", [
    { id: FORM_CLOSURE, account_id: ACCOUNT, type_key: "closure", enabled: true, slug: SLUG_CLOSURE, notice: { en: "Read this first" }, turnstile: false, max_amount: 10000, banks: null },
    { id: FORM_WITHDRAWAL, account_id: ACCOUNT, type_key: "withdrawal", enabled: true, slug: SLUG_WITHDRAWAL, notice: {}, turnstile: false, max_amount: 5000, banks: null },
  ]);
  return db;
}
