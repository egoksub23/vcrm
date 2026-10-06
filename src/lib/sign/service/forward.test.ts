import { beforeEach, describe, expect, it } from "vitest";

import type { FormDefinition, L10n } from "../forms";
import { hashToken } from "../tokens";
import type { NotifyDeps } from "../notify";
import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { FakeDb } from "./fake-db";
import { forwardFromLink, setForwarding, takeBackFromLink } from "./forward";
import { loadProgress } from "./progress";
import { reviewFor } from "./review";
import { notifyCompleted } from "./outcome";
import { remindSigner } from "./send";
import { buildView, completeSigning, declineSigning, fileForSigner, lookupByToken, saveAnswers, type Lookup } from "./signing";
import { uploadFile } from "./uploads";
import { certificateData, valuesFor } from "./seal";
import type { SignDocumentRow, SignSignerRow } from "../types";

// ============================================================
// Forwarding and delegation (migration 166) as the services run them. The database functions are stood in for by
// small handlers that do what the SQL does (the real ones are proved by supabase/ci/verify-166), so what is
// tested here is everything around them: who may forward what, what a delegate is shown and may write, what the
// signer may do while a part is out, what is sent to whom, and what never leaves the server.
// ============================================================

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const DOC = "d1111111-1111-4111-8111-111111111111";
const TOKENS = { sm: "a".repeat(64), sd: "b".repeat(64), dg: "c".repeat(64), nw: "e".repeat(64) } as const;
const META = { ip: "203.0.113.9", device: "Chrome" };

const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });
const FORM: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company details", "Butiran syarikat"), role: "merchant" },
    { key: "bank", title: L("Bank account", "Akaun bank"), role: "merchant" },
    { key: "owner", title: L("Owner"), role: "director" },
  ],
  fields: [
    { key: "legalName", type: "text", part: "company", label: L("Legal name"), required: true, contactField: "company", writeBack: "always" },
    { key: "regNo", type: "text", part: "company", label: L("Registration no."), required: true },
    { key: "accountNo", type: "text", part: "bank", label: L("Account number"), required: true, format: "digits" },
    { key: "bankName", type: "text", part: "bank", label: L("Bank"), required: false },
    { key: "ownerName", type: "text", part: "owner", label: L("Owner name"), required: true },
  ],
};
const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const fields: PlacedField[] = [
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.5, w: 0.4, h: 0.08, required: true },
  { key: "mname", type: "name", role: "merchant", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.04, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.7, w: 0.4, h: 0.08, required: true },
];

const signerRow = (id: string, over: Partial<SignSignerRow> = {}): SignSignerRow & Record<string, unknown> =>
  ({
    id,
    account_id: ACCT,
    document_id: DOC,
    role_key: "merchant",
    kind: "signer",
    full_name: "Ali bin Ahmad",
    email: "ali@kedai.example",
    phone: null,
    channel: "email",
    order_no: 1,
    status: "viewed",
    internal_user_id: null,
    invited_at: "2026-10-06T07:00:00Z",
    viewed_at: "2026-10-06T07:30:00Z",
    signed_at: null,
    declined_at: null,
    decline_reason: null,
    ip: null,
    device: null,
    locale: null,
    consent_version: "v1",
    consented_at: "2026-10-06T07:31:00Z",
    last_reminded_at: null,
    reminder_count: 0,
    part_keys: null,
    delegated_by: null,
    forward_count: 0,
    forward_history: [],
    created_at: "2026-10-06T06:00:00Z",
    updated_at: "2026-10-06T06:00:00Z",
    ...over,
  }) as SignSignerRow & Record<string, unknown>;

interface Mail {
  to: string;
  subject: string;
  text: string;
}

function setup() {
  const db = new FakeDb();
  const mail: Mail[] = [];
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to, subject: a.subject, text: a.text }),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  const ctx: SignCtx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-06T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("contacts", [{ id: "c1", account_id: ACCT, name: "Ali", email: "ali@kedai.example", company: "Kedai Ali", deleted_at: null }]);
  db.seed("sign_documents", [
    {
      id: DOC,
      account_id: ACCT,
      reference: "SGN-2026-000001",
      title: "Merchant Application",
      status: "sent",
      category_id: null,
      template_version_id: null,
      contact_id: "c1",
      merge_values: {},
      fields_snapshot: fields,
      roles_snapshot: roles,
      form_snapshot: FORM,
      sign_in_order: false,
      code_required: false,
      allow_forwarding: true,
      locale: "en",
      message: null,
      expires_at: "2026-10-20T00:00:00Z",
      sent_at: "2026-10-06T06:30:00Z",
      base_path: null,
      page_count: 1,
      created_by: USER,
      created_at: "2026-10-06T06:00:00Z",
    },
  ]);
  db.seed("sign_signers", [signerRow("sm"), signerRow("sd", { role_key: "director", full_name: "Gokula Director", email: "dir@vircle.example", order_no: 2, created_at: "2026-10-06T06:01:00Z" })]);
  db.seed("sign_signer_secrets", [
    { signer_id: "sm", account_id: ACCT, token_hash: hashToken(TOKENS.sm), code_hash: null, code_expires_at: null, code_attempts: 0 },
    { signer_id: "sd", account_id: ACCT, token_hash: hashToken(TOKENS.sd), code_hash: null, code_expires_at: null, code_attempts: 0 },
  ]);

  const doc = () => db.rows("sign_documents")[0];
  const signers = () => db.rows("sign_signers");
  const brief = (id: string, token: string, extra: Record<string, unknown> = {}) => {
    const s = signers().find((x) => x.id === id)!;
    return { signer_id: id, token, name: s.full_name, email: s.email, phone: s.phone, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no, ...extra };
  };

  db.rpcHandlers.sign_log = async (a) => {
    const seq = db.rows("sign_events").filter((e) => e.document_id === a.p_document).length + 1;
    db.seed("sign_events", [{ account_id: ACCT, document_id: a.p_document, doc_seq: seq, type: a.p_type, actor_type: a.p_actor_type, signer_id: a.p_signer, detail: a.p_detail ?? {}, created_at: ctx.now().toISOString() }]);
    return { data: null, error: null };
  };
  // what the database does for a turn: the same row, a new person, a new link; the old one dies
  db.rpcHandlers.sign_forward_turn = async (a) => {
    const s = signers().find((x) => x.id === a.p_signer)!;
    Object.assign(s, { forward_history: [...(s.forward_history as unknown[]), { name: s.full_name, at: ctx.now().toISOString() }], forward_count: (s.forward_count as number) + 1, full_name: a.p_name, email: a.p_email, status: "sent", consented_at: null });
    const secret = db.rows("sign_signer_secrets").find((x) => x.signer_id === s.id)!;
    secret.token_hash = hashToken(TOKENS.nw);
    return { data: brief(s.id as string, TOKENS.nw, { forwarded_by: "Ali bin Ahmad" }), error: null };
  };
  db.rpcHandlers.sign_forward_part = async (a) => {
    const from = signers().find((x) => x.id === a.p_signer)!;
    db.seed("sign_signers", [signerRow("dg", { role_key: from.role_key as string, kind: "filler", full_name: a.p_name as string, email: a.p_email as string, status: "sent", consented_at: null, viewed_at: null, order_no: from.order_no as number, part_keys: [a.p_part as string], delegated_by: from.id as string, created_at: "2026-10-06T08:00:00Z" })]);
    from.forward_count = (from.forward_count as number) + 1;
    db.seed("sign_signer_secrets", [{ signer_id: "dg", account_id: ACCT, token_hash: hashToken(TOKENS.dg), code_hash: null, code_expires_at: null, code_attempts: 0 }]);
    return { data: brief("dg", TOKENS.dg, { forwarded_by: from.full_name, part: a.p_part }), error: null };
  };
  db.rpcHandlers.sign_take_back_part = async (a) => {
    const d = signers().find((x) => x.delegated_by === a.p_signer && (x.part_keys as string[]).includes(a.p_part as string));
    if (!d) return { data: null, error: { message: "part_not_forwarded" } };
    if (d.status === "signed") return { data: null, error: { message: "part_already_completed" } };
    db.tables.sign_signers = signers().filter((x) => x.id !== d.id);
    db.tables.sign_signer_secrets = db.rows("sign_signer_secrets").filter((x) => x.signer_id !== d.id);
    return { data: { removed_delegate: true, part: a.p_part }, error: null };
  };
  db.rpcHandlers.sign_complete_signer = async (a) => {
    const s = signers().find((x) => x.id === a.p_signer)!;
    if (signers().some((x) => x.delegated_by === s.id && x.status !== "signed")) return { data: null, error: { message: "delegation_open" } };
    Object.assign(s, { status: "signed", signed_at: ctx.now().toISOString() });
    const done = signers().every((x) => x.status === "signed");
    doc().status = done ? "sealing" : "in_progress";
    return { data: { sealing: done, invited: [] }, error: null };
  };
  db.rpcHandlers.sign_rotate_token = async (a) => ({ data: brief(a.p_signer as string, "f".repeat(64)), error: null });

  return { db, ctx, mail, doc, signers };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

const look = async (who: keyof typeof TOKENS): Promise<Lookup> => {
  const l = await lookupByToken(t.ctx.admin, TOKENS[who]);
  expect(l).not.toBeNull();
  return l!;
};
const allow = async () => true;
const events = (type: string) => t.db.rows("sign_events").filter((e) => e.type === type);
const person = { fullName: "Siti Finance", email: "siti@kedai.example" };

// ---- who may forward ---------------------------------------------------------------------------------

describe("forwarding is the sender's choice", () => {
  it("is refused when the document does not allow it, and nothing reaches the database", async () => {
    t.doc().allow_forwarding = false;
    await expect(forwardFromLink(t.ctx, await look("sm"), person, META, allow)).rejects.toMatchObject({ code: "forward_not_allowed", status: 403 });
    expect(t.db.rpcCalls.some((c) => c.name.startsWith("sign_forward"))).toBe(false);
    expect(t.mail).toHaveLength(0);
  });

  it("is not offered to the page when it is off, and is offered with what is left when it is on", async () => {
    t.doc().allow_forwarding = false;
    expect((await buildView(t.ctx, await look("sm"), true)).forwarding).toBeNull();
    t.doc().allow_forwarding = true;
    expect((await buildView(t.ctx, await look("sm"), true)).forwarding).toEqual({ canTurn: true, canPart: true, remaining: 2 });
    t.signers().find((s) => s.id === "sm")!.forward_count = 2;
    expect((await buildView(t.ctx, await look("sm"), true)).forwarding).toBeNull();
  });

  it("the sender switches it per document: any time before the document finishes, an event after sending, never on a finished one", async () => {
    t.doc().allow_forwarding = true;
    expect(await setForwarding(t.ctx, DOC, false)).toEqual({ allowForwarding: false });
    expect(t.doc().allow_forwarding).toBe(false);
    expect(events("forwarding_changed")).toMatchObject([{ detail: { allow: false }, actor_type: "user" }]);
    // no change, no event
    await setForwarding(t.ctx, DOC, false);
    expect(events("forwarding_changed")).toHaveLength(1);
    await expect(setForwarding(t.ctx, DOC, "yes")).rejects.toMatchObject({ code: "bad_forwarding" });
    t.doc().status = "draft";
    await setForwarding(t.ctx, DOC, true);
    expect(events("forwarding_changed")).toHaveLength(1);
    t.doc().status = "completed";
    await expect(setForwarding(t.ctx, DOC, false)).rejects.toMatchObject({ code: "document_not_open" });
  });
});

describe("the rules a forward obeys", () => {
  it("refuses a bad name or address, the forwarder's own address, a person already on the document for the role, and a third forward", async () => {
    const l = await look("sm");
    await expect(forwardFromLink(t.ctx, l, { fullName: " ", email: "x@y.example" }, META, allow)).rejects.toMatchObject({ code: "forward_details" });
    await expect(forwardFromLink(t.ctx, l, { fullName: "Siti", email: "nope" }, META, allow)).rejects.toMatchObject({ code: "forward_details" });
    await expect(forwardFromLink(t.ctx, l, { fullName: "Me", email: "ALI@kedai.example" }, META, allow)).rejects.toMatchObject({ code: "forward_same_person" });
    // another signer of the same role
    t.db.seed("sign_signers", [signerRow("sm2", { full_name: "Partner", email: "partner@kedai.example", order_no: 3 })]);
    await expect(forwardFromLink(t.ctx, l, { fullName: "P", email: "partner@kedai.example" }, META, allow)).rejects.toMatchObject({ code: "forward_already_signer" });
    t.signers().find((s) => s.id === "sm")!.forward_count = 2;
    await expect(forwardFromLink(t.ctx, await look("sm"), { fullName: "New Person", email: "new@kedai.example" }, META, allow)).rejects.toMatchObject({ code: "forward_limit" });
    // every refusal happened before the database was asked
    expect(t.db.rpcCalls.filter((c) => c.name === "sign_forward_turn")).toHaveLength(0);
  });

  it("lets a turn go to the person of another role when the document needs no order, and not when it does", async () => {
    t.doc().sign_in_order = true;
    await expect(forwardFromLink(t.ctx, await look("sm"), { fullName: "D", email: "dir@vircle.example" }, META, allow)).rejects.toMatchObject({ code: "forward_already_signer" });
    t.doc().sign_in_order = false;
    await expect(forwardFromLink(t.ctx, await look("sm"), { fullName: "D", email: "dir@vircle.example" }, META, allow)).resolves.toMatchObject({ scope: "turn" });
  });

  it("limits how often one position forwards", async () => {
    const calls: string[] = [];
    const limited = async (key: string, limit: number) => {
      calls.push(`${key}:${limit}`);
      return false;
    };
    await expect(forwardFromLink(t.ctx, await look("sm"), person, META, limited)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(calls).toEqual(["sign:forward:sm:6"]);
    expect(t.db.rpcCalls.some((c) => c.name === "sign_forward_turn")).toBe(false);
  });

  it("keeps the note to what can be read in an email", async () => {
    await expect(forwardFromLink(t.ctx, await look("sm"), { ...person, note: "x".repeat(501) }, META, allow)).rejects.toMatchObject({ code: "forward_details" });
  });

  it("does not let a person who was handed a part pass it on", async () => {
    await forwardFromLink(t.ctx, await look("sm"), { ...person, part: "bank" }, META, allow);
    await expect(forwardFromLink(t.ctx, await look("dg"), { fullName: "Third", email: "third@kedai.example", part: "bank" }, META, allow)).rejects.toMatchObject({ code: "delegate_cannot_forward" });
  });
});

// ---- forwarding a whole turn ---------------------------------------------------------------------------------

describe("forwarding a whole turn", () => {
  it("asks the database for the same row with a limit of two, sends the new person a link of their own with who asked and their note, and tells the sender", async () => {
    const result = await forwardFromLink(t.ctx, await look("sm"), { ...person, note: "Please check the numbers" }, META, allow);
    expect(result).toMatchObject({ scope: "turn", to: "Siti Finance", delivery: { status: "sent" }, remaining: 1 });
    expect(t.db.rpcCalls.find((c) => c.name === "sign_forward_turn")!.args).toMatchObject({ p_signer: "sm", p_name: "Siti Finance", p_email: "siti@kedai.example", p_max: 2, p_ip: "203.0.113.9" });

    const toNew = t.mail.find((m) => m.to === "siti@kedai.example")!;
    expect(toNew.subject).toContain("Ali bin Ahmad passed this on to you");
    expect(toNew.text).toContain(`https://halo.test/s/${TOKENS.nw}`);
    expect(toNew.text).toContain("Please check the numbers");
    expect(toNew.text).toContain("agree to sign electronically yourself");
    const toSender = t.mail.find((m) => m.to === "gokula@vircle.example")!;
    expect(toSender.text).toContain("Ali bin Ahmad passed their turn");
    expect(toSender.text).toContain("Siti Finance");
    // nobody else was written to, and no message carries the old link
    expect(t.mail).toHaveLength(2);
    expect(JSON.stringify(t.mail)).not.toContain(TOKENS.sm);
  });

  it("kills the old link at once and shows the new person their own consent screen with who asked", async () => {
    await forwardFromLink(t.ctx, await look("sm"), person, META, allow);
    expect(await lookupByToken(t.ctx.admin, TOKENS.sm)).toBeNull();
    const view = await buildView(t.ctx, await look("nw"), true);
    expect(view).toMatchObject({ state: "active", needsConsent: true, signer: { name: "Siti Finance" }, forwardedFrom: "Ali bin Ahmad" });
    // one forward used; the new person may pass it on once more
    expect(view.forwarding).toEqual({ canTurn: true, canPart: true, remaining: 1 });
  });

  it("writes no link and no token into the audit trail, and a failed message is recorded for the sender to see", async () => {
    t.ctx.deps.sendEmail = async () => {
      throw new Error("mailbox full");
    };
    const result = await forwardFromLink(t.ctx, await look("sm"), person, META, allow);
    expect(result.delivery.status).toBe("failed");
    expect(events("delivery_failed")).toMatchObject([{ signer_id: "sm", detail: { channel: "email", status: "failed" } }]);
    const text = JSON.stringify(t.db.rows("sign_events"));
    expect(text).not.toContain(TOKENS.nw);
    expect(text).not.toContain("/s/");
  });
});

// ---- forwarding a part -----------------------------------------------------------------------------------------

describe("forwarding one part", () => {
  it("refuses a part that is not the signer's own, and names the part in the new person's email in the document's language", async () => {
    await expect(forwardFromLink(t.ctx, await look("sm"), { ...person, part: "owner" }, META, allow)).rejects.toMatchObject({ code: "forward_part_unknown" });
    await expect(forwardFromLink(t.ctx, await look("sm"), { ...person, part: "nope" }, META, allow)).rejects.toMatchObject({ code: "forward_part_unknown" });
    t.doc().locale = "ms";
    const result = await forwardFromLink(t.ctx, await look("sm"), { ...person, part: "company" }, META, allow);
    expect(result).toMatchObject({ scope: "part", remaining: 1 });
    expect(t.db.rpcCalls.find((c) => c.name === "sign_forward_part")!.args).toMatchObject({ p_signer: "sm", p_part: "company", p_max: 2 });
    const mail = t.mail.find((m) => m.to === "siti@kedai.example")!;
    expect(mail.text).toContain("Butiran syarikat");
    expect(mail.text).toContain(`https://halo.test/s/${TOKENS.dg}`);
    // a part is not announced to the sender by email (the audit trail has it)
    expect(t.mail.some((m) => m.to === "gokula@vircle.example")).toBe(false);
  });

  it("cannot hand over a part that is already with someone", async () => {
    await forwardFromLink(t.ctx, await look("sm"), { ...person, part: "company" }, META, allow);
    await expect(forwardFromLink(t.ctx, await look("sm"), { fullName: "Other", email: "other@kedai.example", part: "company" }, META, allow)).rejects.toMatchObject({ code: "forward_part_unknown" });
  });

  it("can be taken back while it is open, and not once it is completed", async () => {
    await forwardFromLink(t.ctx, await look("sm"), { ...person, part: "company" }, META, allow);
    expect(await takeBackFromLink(t.ctx, await look("sm"), "company", META)).toEqual({ part: "company", removed: true });
    expect(t.signers().some((s) => s.id === "dg")).toBe(false);
    await forwardFromLink(t.ctx, await look("sm"), { ...person, part: "bank" }, META, allow);
    t.signers().find((s) => s.id === "dg")!.status = "signed";
    await expect(takeBackFromLink(t.ctx, await look("sm"), "bank", META)).rejects.toMatchObject({ code: "part_already_completed" });
    // a delegate is not the one who may take a part back
    t.signers().find((s) => s.id === "dg")!.status = "viewed";
    await expect(takeBackFromLink(t.ctx, await look("dg"), "bank", META)).rejects.toMatchObject({ code: "delegate_cannot_forward" });
  });
});

// ---- what a delegate sees and may write ---------------------------------------------------------------------------

describe("a person handed one part", () => {
  beforeEach(async () => {
    await forwardFromLink(t.ctx, await look("sm"), { ...person, part: "bank" }, META, allow);
    // they open their link and agree for themselves
    Object.assign(t.signers().find((s) => s.id === "dg")!, { consented_at: "2026-10-06T08:05:00Z", status: "viewed", viewed_at: "2026-10-06T08:05:00Z" });
  });

  it("is shown their part and nothing else: no pages, no placed fields, nobody else, nothing from the contact", async () => {
    const view = await buildView(t.ctx, await look("dg"), true);
    expect(view).toMatchObject({ state: "active", delegate: true, forwardedFrom: "Ali bin Ahmad", forwarding: null });
    expect(view.content).toMatchObject({ fields: [], answers: {}, othersAnswers: {}, others: [], missing: [], delegations: [] });
    expect(view.content!.form!.partKeys).toEqual(["bank"]);
    expect(view.content!.form!.definition.parts.map((p) => p.key)).toEqual(["bank"]);
    expect(view.content!.form!.definition.fields.map((f) => f.key)).toEqual(["accountNo", "bankName"]);
    // the contact's company (a field of the company part) is nowhere in what they were sent
    expect(JSON.stringify(view)).not.toContain("Kedai Ali");
    expect(t.db.rows("sign_answers")).toHaveLength(0);
  });

  it("cannot read the document or its review, and cannot end it by declining", async () => {
    expect(await fileForSigner(t.ctx, await look("dg"), true)).toBeNull();
    await expect(reviewFor(t.ctx, await look("dg"))).rejects.toMatchObject({ status: 403 });
    await expect(declineSigning(t.ctx, await look("dg"), "no", META)).rejects.toMatchObject({ code: "delegate_cannot_decline" });
    expect(t.db.rpcCalls.some((c) => c.name === "sign_decline_signer")).toBe(false);
  });

  it("writes only the fields of their part, marked as forwarded, and is told the part's progress", async () => {
    const r = await saveAnswers(t.ctx, await look("dg"), { accountNo: { text: "1234567890" }, regNo: { text: "20190123456" }, msig: { typed: "Siti" } });
    expect(r.saved).toEqual(["accountNo"]);
    expect(r.rejected).toEqual(expect.arrayContaining([{ field: "regNo", code: "not_your_field" }, { field: "msig", code: "not_your_field" }]));
    expect(t.db.rows("sign_answers")).toMatchObject([{ signer_id: "dg", field_key: "accountNo", source: "forwarded" }]);
    expect(r.ready).toBe(true); // the only required field of their part is in
    expect(r.progress).toMatchObject([{ key: "bank", state: "done" }]);
  });

  it("cannot upload to a field of a part they do not hold", async () => {
    await expect(uploadFile(t.ctx, await look("dg"), { field: "regNo", file: { bytes: new Uint8Array([1]), name: "a.pdf" } })).rejects.toMatchObject({ code: "not_your_field" });
  });

  it("submits their part (and only it is required), without writing anything to the contact", async () => {
    await expect(completeSigning(t.ctx, await look("dg"), {}, { ...META, locale: "en" })).rejects.toMatchObject({ code: "missing_required", issues: [{ field: "accountNo" }] });
    await completeSigning(t.ctx, await look("dg"), { accountNo: { text: "1234567890" } }, { ...META, locale: "en" });
    expect(t.signers().find((s) => s.id === "dg")!.status).toBe("signed");
    expect(t.db.rows("contacts")[0]).toMatchObject({ company: "Kedai Ali" });
    expect(events("writeback")).toHaveLength(0);
  });

  it("is not sent the signed copy when the document is done", async () => {
    t.signers().find((s) => s.id === "dg")!.status = "signed";
    t.signers().find((s) => s.id === "sm")!.status = "signed";
    t.signers().find((s) => s.id === "sd")!.status = "signed";
    t.mail.length = 0; // (the invitation the forward sent is not what is asked about)
    await notifyCompleted(t.ctx, t.doc() as unknown as SignDocumentRow, t.signers() as unknown as SignSignerRow[], new Uint8Array([1, 2, 3]));
    const to = t.mail.map((m) => m.to).sort();
    expect(to).toEqual(["ali@kedai.example", "dir@vircle.example", "gokula@vircle.example"].sort());
  });
});

// ---- what the signer sees and may do while a part is out ------------------------------------------------------------

describe("the signer who handed a part over", () => {
  beforeEach(async () => {
    await forwardFromLink(t.ctx, await look("sm"), { ...person, part: "bank" }, META, allow);
    Object.assign(t.signers().find((s) => s.id === "dg")!, { consented_at: "2026-10-06T08:05:00Z", status: "viewed" });
  });

  it("sees the part as waiting for the delegate, read only, and the delegate is not a person of the document", async () => {
    const view = await buildView(t.ctx, await look("sm"), true);
    expect(view.content!.delegations).toEqual([{ part: "bank", signerId: "dg", name: "Siti Finance", done: false }]);
    expect(view.content!.others.map((o) => o.name)).toEqual(["Gokula Director"]);
    // the signer's own parts are still theirs
    expect(view.content!.form!.partKeys).toEqual(["company", "bank"]);
  });

  it("cannot write to the part any more, and the part's answers are the delegate's alone", async () => {
    await saveAnswers(t.ctx, await look("dg"), { accountNo: { text: "1234567890" } });
    const own = await saveAnswers(t.ctx, await look("sm"), { accountNo: { text: "999" }, legalName: { text: "Kedai Ali Sdn Bhd" } });
    expect(own.saved).toEqual(["legalName"]);
    expect(own.rejected).toEqual([{ field: "accountNo", code: "not_your_field" }]);
    const view = await buildView(t.ctx, await look("sm"), true);
    expect(view.content!.form!.answers.accountNo).toEqual({ text: "1234567890" });
  });

  it("is not ready to sign while the part is out, even when its answers are in, and cannot finish", async () => {
    await saveAnswers(t.ctx, await look("dg"), { accountNo: { text: "1234567890" } });
    const own = await saveAnswers(t.ctx, await look("sm"), { legalName: { text: "Kedai Ali" }, regNo: { text: "20190123456" } });
    expect(own.ready).toBe(false);
    await expect(completeSigning(t.ctx, await look("sm"), { msig: { typed: "Ali" } }, { ...META, locale: "en" })).rejects.toMatchObject({ code: "delegation_open", status: 409 });
    expect(t.db.rpcCalls.some((c) => c.name === "sign_complete_signer")).toBe(false);
    // the delegate submits: now the signer is ready and can finish; the part's answers count
    await completeSigning(t.ctx, await look("dg"), { accountNo: { text: "1234567890" } }, { ...META, locale: "en" });
    const view = await buildView(t.ctx, await look("sm"), true);
    expect(view.content!.form!.ready).toBe(true);
    expect(view.content!.delegations).toMatchObject([{ part: "bank", done: true }]);
    await expect(completeSigning(t.ctx, await look("sm"), { msig: { typed: "Ali" } }, { ...META, locale: "en" })).resolves.toMatchObject({ sealing: false });
  });

  it("keeps what the delegate typed when the part is taken back, as the signer's own", async () => {
    await saveAnswers(t.ctx, await look("dg"), { accountNo: { text: "1234567890" } });
    // the database moves the answers to the signer; the double of it does the same
    const delegateAnswer = t.db.rows("sign_answers").find((a) => a.signer_id === "dg")!;
    await takeBackFromLink(t.ctx, await look("sm"), "bank", META);
    delegateAnswer.signer_id = "sm";
    const view = await buildView(t.ctx, await look("sm"), true);
    expect(view.content!.form!.answers.accountNo).toEqual({ text: "1234567890" });
    expect(view.content!.delegations).toEqual([]);
  });

  it("is reminded only of the parts they can do, and the delegate only of theirs", async () => {
    await remindSigner(t.ctx, DOC, "sm");
    expect(t.mail.at(-1)!.text).toContain("Company details");
    expect(t.mail.at(-1)!.text).not.toContain("Bank account");
    await remindSigner(t.ctx, DOC, "dg");
    expect(t.mail.at(-1)!.text).toContain("Bank account");
    expect(t.mail.at(-1)!.text).not.toContain("Company details");
  });
});

// ---- what the sender sees -------------------------------------------------------------------------------------------

describe("the sender's progress", () => {
  it("shows who holds each part and keeps the delegate out of the roles", async () => {
    await forwardFromLink(t.ctx, await look("sm"), { ...person, part: "bank" }, META, allow);
    const progress = await loadProgress(t.ctx, DOC);
    const merchant = progress.roles.find((r) => r.roleKey === "merchant")!;
    expect(merchant.signer).toMatchObject({ id: "sm", name: "Ali bin Ahmad" });
    expect(merchant.delegations).toEqual([{ part: "bank", name: "Siti Finance", done: false }]);
    expect(progress.roles.find((r) => r.roleKey === "director")!.delegations).toBeUndefined();
  });
});

// ---- the sealed document ---------------------------------------------------------------------------------------------

describe("the sealed document", () => {
  it("writes the signer's places for the signer, never for a delegate of the same role", () => {
    const people = [
      signerRow("dg", { kind: "filler", full_name: "Siti", part_keys: ["bank"], delegated_by: "sm", created_at: "2026-10-06T05:00:00Z" }),
      signerRow("sm", { status: "signed", signed_at: "2026-10-06T09:00:00Z" }),
    ];
    const values = valuesFor(fields, people, [{ signer_id: "sm", field_key: "msig", value: { typed: "Ali" } }]);
    expect(values.msig).toEqual({ typed: "Ali" });
    expect(values.mname).toEqual({ text: "Ali bin Ahmad" });
  });

  it("lists signers by step with people who sign together side by side, and each delegate after the person who gave the part", () => {
    const doc = { ...t.doc(), sign_in_order: true } as unknown as SignDocumentRow;
    const people = [
      signerRow("s3", { full_name: "Third", email: "3@x.example", order_no: 3, status: "signed", signed_at: "2026-10-06T12:00:00Z", role_key: "director" }),
      signerRow("s2", { full_name: "Second B", email: "2b@x.example", order_no: 2, status: "signed", signed_at: "2026-10-06T11:00:00Z", created_at: "2026-10-06T06:03:00Z" }),
      signerRow("dg", { full_name: "Delegate", email: "d@x.example", kind: "filler", part_keys: ["bank"], delegated_by: "s2", order_no: 2, status: "signed", signed_at: "2026-10-06T10:30:00Z" }),
      signerRow("s2a", { full_name: "Second A", email: "2a@x.example", order_no: 2, status: "signed", signed_at: "2026-10-06T10:00:00Z", created_at: "2026-10-06T06:02:00Z" }),
      signerRow("s1", { full_name: "First", email: "1@x.example", order_no: 1, status: "signed", signed_at: "2026-10-06T09:00:00Z" }),
    ];
    const data = certificateData(doc, people, [], { workspaceName: "Vircle", senderName: "Gokula", timeZone: "UTC" }, "https://halo.test", 1);
    expect(data.signers.map((s) => [s.name, s.order])).toEqual([
      ["First", 1],
      ["Second A", 2],
      ["Second B", 2],
      ["Delegate", undefined],
      ["Third", 3],
    ]);
    expect(data.signers.find((s) => s.name === "Delegate")!.role).toBe("Merchant (Bank account)");
  });

  it("words the history with the forwarder's name on what they did, and each invitation with its cause", () => {
    const doc = t.doc() as unknown as SignDocumentRow;
    const people = [signerRow("sm", { full_name: "Siti Finance" })];
    const events = [
      { created_at: "2026-10-06T07:00:00Z", type: "consented", signer_id: "sm", row_hash: "h1", detail: {} },
      { created_at: "2026-10-06T08:00:00Z", type: "forwarded", signer_id: "sm", row_hash: "h2", detail: { scope: "turn", from_name: "Ali bin Ahmad", to_name: "Siti Finance", to_email: "s***@kedai.example" } },
      { created_at: "2026-10-06T08:10:00Z", type: "consented", signer_id: "sm", row_hash: "h3", detail: {} },
      { created_at: "2026-10-06T08:11:00Z", type: "invited", signer_id: "sm", row_hash: "h4", detail: { because: "step_finished", step: 2 } },
      { created_at: "2026-10-06T08:12:00Z", type: "invited", signer_id: "sm", row_hash: "h5", detail: { because: "signer_finished", finished_name: "Ali", step: 2 } },
    ];
    const data = certificateData(doc, people, events, { workspaceName: "Vircle", senderName: "Gokula", timeZone: "UTC" }, "https://halo.test", 1);
    expect(data.events.map((e) => e.text)).toEqual([
      "Ali bin Ahmad agreed to sign electronically",
      "Ali bin Ahmad forwarded their turn to Siti Finance",
      "Siti Finance agreed to sign electronically",
      "Siti Finance was invited because the previous step finished",
      "Siti Finance was invited because Ali finished",
    ]);
    // the masked address is not on the certificate
    expect(JSON.stringify(data.events)).not.toContain("kedai.example");
  });
});
