// A small world for the tests of the people model (migration 175): a FakeDb with the envelope functions stood in, a mail recorder that can be made to
// fail for an address, a workspace and a sender, and helpers to make collections of uploaded files. Imported only by tests.

import { createHash } from "node:crypto";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import { createSelfSignedP12 } from "../pdf/p12";
import type { PlacedField } from "../pdf/types";
import type { SignDocumentRow, SignRole, SignSignerRow } from "../types";
import type { SignCtx } from "./context";
import { installEnvelopeRpcs } from "./envelope-fake";
import { createEnvelopeDraft, type EnvelopePersonInput } from "./envelopes";
import { FakeDb } from "./fake-db";

export const ACCT = "11111111-1111-4111-8111-111111111111";
export const OTHER = "99999999-9999-4999-8999-999999999999";
export const USER = "22222222-2222-4222-8222-222222222222";
export const OTHER_USER = "88888888-8888-4888-8888-888888888888";
export const TPL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const TPL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SENDER_EMAIL = "gokula@vircle.example";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: string }[];
}

export const templateRoles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
export const templateFields: PlacedField[] = [
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

export interface World {
  db: FakeDb;
  ctx: SignCtx;
  mail: Mail[];
  tokens: Map<string, string>;
  /** Addresses (lower case) the mail recorder refuses, as a mail server would. */
  failTo: Set<string>;
  pdf: Uint8Array;
  file: (name: string) => { bytes: Uint8Array; filename: string };
  rpcs: (name: string) => { name: string; args: Record<string, unknown> }[];
  events: (type: string) => { name: string; args: Record<string, unknown> }[];
  docRows: () => SignDocumentRow[];
  signerRows: () => SignSignerRow[];
  copyRows: () => Record<string, unknown>[];
  seedTemplate: (id: string, name: string, over?: { account?: string; mode?: "sign" | "form" }) => Promise<void>;
  seedCertificate: () => void;
}

export async function makeWorld(): Promise<World> {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  const db = new FakeDb();
  const mail: Mail[] = [];
  const failTo = new Set<string>();
  let counter = 0;
  let tokenN = 0;
  let copyN = 0;
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => {
      if (failTo.has(a.to.toLowerCase())) throw new Error("mailbox unavailable");
      mail.push({ to: a.to, subject: a.subject, text: a.text, html: a.html, attachments: a.attachments as Mail["attachments"] });
      return undefined as never;
    },
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  const ctx: SignCtx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-06T08:00:00Z") };
  db.seed("accounts", [
    { id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" },
    { id: OTHER, name: "Other Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" },
  ]);
  db.seed("profiles", [
    { user_id: USER, account_id: ACCT, full_name: "Gokula", email: SENDER_EMAIL },
    { user_id: OTHER_USER, account_id: OTHER, full_name: "Other Sender", email: "sender@other.example" },
  ]);
  const settings = { default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" };
  db.seed("sign_settings", [
    { id: "set1", account_id: ACCT, ...settings },
    { id: "set2", account_id: OTHER, ...settings },
  ]);
  db.seed("account_platform", [
    { account_id: ACCT, status: "active", features: { sign: true }, limits: {} },
    { account_id: OTHER, status: "active", features: { sign: true }, limits: {} },
  ]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  db.insertDefaults.sign_envelopes = () => ({ status: "draft", reference: `COL-2026-00000${++counter}`, locale: "en", sign_in_order: false, code_required: false, message: null, reminder_days: null, expires_at: null, sent_at: null, completed_at: null, void_reason: null, end_notified_at: null });
  db.insertDefaults.sign_documents = () => ({ reference: `SGN-2026-00000${++counter}`, mode: "sign", test: false, merge_values: {}, form_snapshot: null, envelope_id: null, envelope_position: null, final_path: null, final_sha256: null, completed_at: null, retain_until: null, void_reason: null, sent_at: null, expires_at: null });
  db.insertDefaults.sign_signers = () => ({ status: "pending", kind: "signer", invited_at: null, viewed_at: null, signed_at: null, consented_at: null, consent_version: null, last_reminded_at: null, reminder_count: 0, part_keys: null, delegated_by: null, forward_count: 0, forward_history: [], party_id: null, locale: null, ip: null, device: null, phone: null });
  // the database numbers copy recipients in the order they are added (created_at); the fake clock would give them all one instant
  db.insertDefaults.sign_copy_recipients = () => ({ notified_at: null, created_at: new Date(Date.parse("2026-10-06T08:00:00Z") + ++copyN * 1000).toISOString() });
  const fake = installEnvelopeRpcs(db, { newToken: () => (++tokenN).toString(16).padStart(64, "0"), now: () => "2026-10-06T08:00:00.000Z" });
  const pdf = await makePdf([{ ...A4 }]);

  const world: World = {
    db,
    ctx,
    mail,
    tokens: fake.tokens,
    failTo,
    pdf,
    file: (filename) => ({ bytes: pdf, filename }),
    rpcs: (name) => db.rpcCalls.filter((c) => c.name === name),
    events: (type) => db.rpcCalls.filter((c) => c.name === "sign_log" && c.args.p_type === type),
    docRows: () => db.rows("sign_documents") as unknown as SignDocumentRow[],
    signerRows: () => db.rows("sign_signers") as unknown as SignSignerRow[],
    copyRows: () => db.rows("sign_copy_recipients"),
    seedTemplate: async (id, name, over = {}) => {
      const account = over.account ?? ACCT;
      const bytes = await makePdf([{ ...A4 }]);
      const sha = createHash("sha256").update(bytes).digest("hex");
      db.files.set(`account-${account}/templates/${id}/v1.pdf`, bytes);
      db.seed("sign_templates", [{ id, account_id: account, name, status: "active", category_id: null, current_version_id: `ver-${id}` }]);
      db.seed("sign_template_versions", [{ id: `ver-${id}`, account_id: account, template_id: id, version_no: 1, source_path: `account-${account}/templates/${id}/v1.pdf`, source_sha256: sha, original_path: null, page_count: 1, fields: templateFields, roles: templateRoles, defaults: {}, mode: over.mode ?? "sign" }]);
    },
    seedCertificate: () => {
      const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
      db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true }]);
    },
  };
  await world.seedTemplate(TPL_A, "Merchant Agreement");
  await world.seedTemplate(TPL_B, "Fee Schedule");
  return world;
}

/** A person who must sign, as the signers route hands it to the service. */
export const signerIn = (fullName: string, email: string, key?: string, over: Partial<EnvelopePersonInput> = {}): EnvelopePersonInput => ({ fullName, email, channel: "email", roles: {}, ...(key ? { key } : {}), ...over });
/** A person who receives a copy. */
export const copyIn = (fullName: string, email: string, key?: string): EnvelopePersonInput => ({ fullName, email, channel: "email", roles: {}, type: "copy", ...(key ? { key } : {}) });

/** A signature placed on page 1 for a role. */
export const sig = (key: string, role: string, over: Partial<PlacedField> = {}): PlacedField => ({ key, type: "signature", role, page: 0, x: 0.1, y: 0.1 + (key.length % 7) * 0.1, w: 0.3, h: 0.06, required: true, ...over });

export const ALI_KEY = "pp_aliaaaa1";
export const BALA_KEY = "pp_balabbbb2";
export const CARA_KEY = "pp_caracccc3";

/** A draft collection of `n` uploaded files (and, optionally, templates after them). */
export async function uploadedCollection(w: World, n = 2, templateIds: string[] = []) {
  const files = Array.from({ length: n }, (_, i) => w.file(`File ${i + 1}.pdf`));
  const { envelope, documents } = await createEnvelopeDraft(w.ctx, { templateIds, files });
  return { envelope, documents, ids: documents.map((d) => d.id) };
}

/** A fresh read of one document's row. */
export const docOf = (w: World, id: string) => w.docRows().find((d) => d.id === id)!;
