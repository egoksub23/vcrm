// Countersigning inside Halo and the two shortcut lists: who is waiting for whom (order rules, only my turn, isolation
// between people and workspaces), opening my own turn (every refusal, the link rotation touches nobody else, the audit
// wording, the session cookie that stands in for the code), the Halo users a sender may name, and "Needs attention".
// The database functions behind it (rotation, the notification) are proved by supabase/ci/verify-158 and verify-167.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashToken, sessionCookieName, verifySession } from "../tokens";
import type { NotifyDeps } from "../notify";
import { assertAccountMembers, HALO_LOGIN_METHOD, listAwaitingMe, listNeedsAttention, openCountersign, SHORTCUT_LIMIT } from "./countersign";
import type { SignCtx } from "./context";
import { SignError } from "./errors";
import { FakeDb } from "./fake-db";

const DAY = 24 * 3600 * 1000;
const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCT = "99999999-9999-4999-8999-999999999999";
const SENDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DIRECTOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SOMEONE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2026-10-06T08:00:00Z");
const iso = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

let db: FakeDb;
let tokens: Map<string, string>;
let events: { type: string; signer: string | null; actor: string; user: string | null; detail: Record<string, unknown>; ip: string | null }[];
let saved: { key: string | undefined; keys: string | undefined };

function ctxFor(userId: string | null, accountId = ACCT): SignCtx {
  const deps: NotifyDeps = { emailConfigured: () => false, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "x" }), sendWhatsApp: async () => {} };
  return { admin: db.client(), accountId, userId, origin: "https://halo.test", deps, now: () => NOW };
}

function doc(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    account_id: ACCT,
    title: `Agreement ${id}`,
    reference: `SIGN-${id}`,
    status: "sent",
    created_by: SENDER,
    sent_at: iso(-2),
    expires_at: iso(10),
    sign_in_order: false,
    code_required: true,
    roles_snapshot: [
      { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
      { key: "director", label: "Director", kind: "signer", color: 1 },
    ],
    updated_at: iso(-1),
    ...over,
  };
}

function signer(id: string, documentId: string, over: Record<string, unknown> = {}) {
  return { id, account_id: ACCT, document_id: documentId, role_key: "director", kind: "signer", full_name: "Director", email: "dir@example.com", order_no: 1, status: "sent", internal_user_id: DIRECTOR, created_at: iso(-2), ...over };
}

beforeEach(() => {
  saved = { key: process.env.ENCRYPTION_KEY, keys: process.env.ENCRYPTION_KEYS };
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  delete process.env.ENCRYPTION_KEYS;
  db = new FakeDb();
  tokens = new Map();
  events = [];
  db.seed("profiles", [
    { user_id: SENDER, account_id: ACCT, full_name: "Gokula" },
    { user_id: DIRECTOR, account_id: ACCT, full_name: "Director", email: "dir@example.com" },
    { user_id: SOMEONE, account_id: ACCT, full_name: "Someone", email: "someone@example.com" },
  ]);
  // The real function (migration 158) refuses a signer who is not invited or finished, and makes a new token for that one signer only.
  db.rpcHandlers.sign_rotate_token = async (args) => {
    const s = db.rows("sign_signers").find((x) => x.id === args.p_signer);
    if (!s || !["sent", "viewed"].includes(s.status as string)) return { data: null, error: { message: "signer_not_open" } };
    const token = `${String(s.id).replace(/-/g, "")}`.padEnd(64, "f").slice(0, 64);
    tokens.set(s.id as string, token);
    events.push({ type: String(args.p_reason), signer: s.id as string, actor: "user", user: args.p_actor as string, detail: {}, ip: null });
    return { data: { signer_id: s.id, token, name: s.full_name, email: s.email, phone: null, channel: "email", role_key: s.role_key, kind: s.kind, order_no: s.order_no }, error: null };
  };
  db.rpcHandlers.sign_log = async (args) => {
    events.push({ type: String(args.p_type), signer: (args.p_signer as string | null) ?? null, actor: String(args.p_actor_type), user: (args.p_user as string | null) ?? null, detail: (args.p_detail as Record<string, unknown>) ?? {}, ip: (args.p_ip as string | null) ?? null });
    return { data: null, error: null };
  };
});

afterEach(() => {
  if (saved.key === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = saved.key;
  if (saved.keys === undefined) delete process.env.ENCRYPTION_KEYS;
  else process.env.ENCRYPTION_KEYS = saved.keys;
});

describe("listAwaitingMe", () => {
  it("lists the documents whose turn it is for the signed-in Halo user, with what the list shows", async () => {
    db.seed("sign_documents", [doc("d1")]);
    db.seed("sign_signers", [signer("s1", "d1")]);
    const items = await listAwaitingMe(ctxFor(DIRECTOR));
    expect(items).toEqual([
      { documentId: "d1", signerId: "s1", title: "Agreement d1", reference: "SIGN-d1", roleLabel: "Director", senderName: "Gokula", sentAt: iso(-2), expiresAt: iso(10), step: null },
    ]);
  });

  it("includes someone who has opened the document but not finished, and shows the step when signing follows an order", async () => {
    db.seed("sign_documents", [doc("d1", { sign_in_order: true, status: "in_progress" })]);
    db.seed("sign_signers", [signer("s0", "d1", { internal_user_id: null, order_no: 1, status: "signed" }), signer("s1", "d1", { order_no: 2, status: "viewed" })]);
    const items = await listAwaitingMe(ctxFor(DIRECTOR));
    expect(items.map((i) => [i.signerId, i.step])).toEqual([["s1", 2]]);
  });

  it("does not list a later step that has not begun (ordered documents keep it pending until the step before has finished)", async () => {
    db.seed("sign_documents", [doc("d1", { sign_in_order: true })]);
    db.seed("sign_signers", [signer("s0", "d1", { internal_user_id: null, order_no: 1, status: "sent" }), signer("s1", "d1", { order_no: 2, status: "pending" })]);
    expect(await listAwaitingMe(ctxFor(DIRECTOR))).toEqual([]);
  });

  it("does not list what is signed, declined, or on a document that is not open any more or has run past its expiry", async () => {
    db.seed("sign_documents", [doc("d-signed"), doc("d-declined"), doc("d-voided", { status: "voided" }), doc("d-done", { status: "completed" }), doc("d-draft", { status: "draft" }), doc("d-late", { expires_at: iso(-1) }), doc("d-sealing", { status: "sealing" })]);
    db.seed("sign_signers", [
      signer("a", "d-signed", { status: "signed" }),
      signer("b", "d-declined", { status: "declined" }),
      signer("c", "d-voided"),
      signer("d", "d-done"),
      signer("e", "d-draft", { status: "pending" }),
      signer("f", "d-late"),
      signer("g", "d-sealing"),
    ]);
    expect(await listAwaitingMe(ctxFor(DIRECTOR))).toEqual([]);
  });

  it("is only ever my own places: not another Halo user's, not an outside signer's, not another workspace's", async () => {
    db.seed("sign_documents", [doc("d1"), doc("d2"), doc("d3", { account_id: OTHER_ACCT })]);
    db.seed("sign_signers", [
      signer("mine", "d1"),
      signer("theirs", "d2", { internal_user_id: SOMEONE }),
      signer("outside", "d2", { internal_user_id: null, email: "ali@example.com" }),
      // the same user id on a document of another workspace: never shown in this one
      signer("foreign", "d3", { account_id: OTHER_ACCT }),
    ]);
    expect((await listAwaitingMe(ctxFor(DIRECTOR))).map((i) => i.signerId)).toEqual(["mine"]);
    expect((await listAwaitingMe(ctxFor(SOMEONE))).map((i) => i.signerId)).toEqual(["theirs"]);
    expect(await listAwaitingMe(ctxFor(SENDER))).toEqual([]);
    // signed in to the other workspace, the same person sees that workspace's place and none of the first one's
    expect((await listAwaitingMe(ctxFor(DIRECTOR, OTHER_ACCT))).map((i) => i.signerId)).toEqual(["foreign"]);
    expect(await listAwaitingMe(ctxFor(SOMEONE, OTHER_ACCT))).toEqual([]);
  });

  it("lists a person's two roles on one document as two places, the oldest sent first", async () => {
    db.seed("sign_documents", [doc("d-old", { sent_at: iso(-5) }), doc("d-new", { sent_at: iso(-1) })]);
    db.seed("sign_signers", [signer("n", "d-new"), signer("o1", "d-old", { role_key: "merchant" }), signer("o2", "d-old")]);
    const items = await listAwaitingMe(ctxFor(DIRECTOR));
    expect(items.map((i) => [i.documentId, i.signerId])).toEqual([["d-old", "o1"], ["d-old", "o2"], ["d-new", "n"]]);
  });

  it("needs a signed-in person", async () => {
    await expect(listAwaitingMe(ctxFor(null))).rejects.toMatchObject({ status: 401 });
  });

  it("answers at most the shortcut limit", async () => {
    const docs = Array.from({ length: SHORTCUT_LIMIT + 20 }, (_, i) => doc(`d${i}`));
    db.seed("sign_documents", docs);
    db.seed("sign_signers", docs.map((d, i) => signer(`s${i}`, d.id as string)));
    expect((await listAwaitingMe(ctxFor(DIRECTOR))).length).toBe(SHORTCUT_LIMIT);
  });
});

describe("openCountersign", () => {
  const meta = { ip: "203.0.113.9", device: "Chrome" };
  const code = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(SignError);
    return { code: (e as SignError).code, status: (e as SignError).status };
  };

  it("gives the Halo user a fresh link and the session that skips the code, and records both honestly", async () => {
    db.seed("sign_documents", [doc("d1")]);
    db.seed("sign_signers", [signer("s1", "d1")]);
    const opened = await openCountersign(ctxFor(DIRECTOR), "d1", meta);
    expect(opened.signerId).toBe("s1");
    expect(opened.token).toBe(tokens.get("s1"));
    // the session is for this signer only and is accepted by the same check the signer page makes
    expect(opened.session).not.toBeNull();
    expect(verifySession(opened.session!.value, "s1", NOW)).toBe(true);
    expect(verifySession(opened.session!.value, "s2", NOW)).toBe(false);
    expect(sessionCookieName("s1")).toBe("sgs-s1");
    // the audit trail: a link was made (not "sent"), and the person was identified by their Halo sign-in, with their user id, address and device
    expect(events.map((e) => e.type)).toEqual(["halo_link", "code_verified"]);
    expect(events[0]).toMatchObject({ type: "halo_link", signer: "s1", user: DIRECTOR });
    expect(events[1]).toMatchObject({ type: "code_verified", signer: "s1", actor: "signer", user: DIRECTOR, ip: "203.0.113.9", detail: { method: HALO_LOGIN_METHOD } });
    expect(events.some((e) => e.type === "resent" || e.type === "reminded")).toBe(false);
    // nothing is stored or sent from here: no email went out and the link was not written anywhere but the answer
    expect(JSON.stringify(events)).not.toContain(opened.token);
  });

  it("rotates only this person's link: one call, for this signer, and nobody else's link changes", async () => {
    db.seed("sign_documents", [doc("d1")]);
    db.seed("sign_signers", [signer("s1", "d1"), signer("s2", "d1", { internal_user_id: SOMEONE, role_key: "merchant" }), signer("s3", "d1", { internal_user_id: null, role_key: "merchant", email: "ali@example.com" })]);
    tokens.set("s2", "keep-2");
    tokens.set("s3", "keep-3");
    await openCountersign(ctxFor(DIRECTOR), "d1", meta);
    const rotations = db.rpcCalls.filter((c) => c.name === "sign_rotate_token");
    expect(rotations).toHaveLength(1);
    expect(rotations[0].args).toMatchObject({ p_signer: "s1", p_actor: DIRECTOR, p_reason: "halo_link" });
    expect(tokens.get("s2")).toBe("keep-2");
    expect(tokens.get("s3")).toBe("keep-3");
    expect(hashToken(tokens.get("s1")!)).toMatch(/^[0-9a-f]{64}$/);
  });

  // WP25 review: the Halo sign-in replaces the emailed link and code, so it must be the person the place is addressed to
  it("refuses a place that is addressed to someone else's email, even when the sender named this Halo user for it", async () => {
    db.seed("sign_documents", [doc("d1")]);
    // a sender (SOMEONE) put themselves on a place with a client's name and address: they hold no key to that mailbox
    db.seed("sign_signers", [signer("forged", "d1", { internal_user_id: SOMEONE, full_name: "Mr Client", email: "client@bigcorp.example" })]);
    tokens.set("forged", "the-clients-link");
    expect(await code(openCountersign(ctxFor(SOMEONE), "d1", meta))).toEqual({ code: "countersign_other_address", status: 403 });
    expect(tokens.get("forged")).toBe("the-clients-link");
    expect(db.rpcCalls.filter((c) => c.name === "sign_rotate_token")).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("opens a place addressed to the person's own address in any case, or the same mailbox with a +tag (the test mode's way)", async () => {
    db.seed("sign_documents", [doc("d1"), doc("d2")]);
    db.seed("sign_signers", [signer("a", "d1", { email: "DIR@Example.com" }), signer("b", "d2", { email: "dir+director@example.com" })]);
    expect((await openCountersign(ctxFor(DIRECTOR), "d1", meta)).signerId).toBe("a");
    expect((await openCountersign(ctxFor(DIRECTOR), "d2", meta)).signerId).toBe("b");
  });

  it("opens the one place that is addressed to them when they hold two on a document", async () => {
    db.seed("sign_documents", [doc("d1")]);
    db.seed("sign_signers", [signer("x", "d1", { role_key: "merchant", email: "client@bigcorp.example", order_no: 1 }), signer("y", "d1", { email: "dir@example.com", order_no: 2 })]);
    expect((await openCountersign(ctxFor(DIRECTOR), "d1", meta)).signerId).toBe("y");
  });

  it("for a person of an envelope rotates the link of the person's first document and sets the session for that row, never for another row of theirs", async () => {
    db.seed("sign_documents", [doc("d1", { envelope_id: "env1", envelope_position: 1 }), doc("d2", { envelope_id: "env1", envelope_position: 2 })]);
    db.seed("sign_signers", [signer("anchor", "d1", { party_id: "anchor" }), signer("second", "d2", { party_id: "anchor" })]);
    db.rpcHandlers.sign_envelope_rotate_token = async (args) => {
      tokens.set(String(args.p_anchor), "anchors-new-link");
      return { data: { signer_id: args.p_anchor, token: "anchors-new-link", envelope_id: "env1" }, error: null };
    };
    // asked from the second document: the link and the session still belong to the anchor, which is what the link's page looks the person up by
    const opened = await openCountersign(ctxFor(DIRECTOR), "d2", meta);
    expect(opened.signerId).toBe("anchor");
    expect(opened.token).toBe("anchors-new-link");
    expect(verifySession(opened.session!.value, "anchor", NOW)).toBe(true);
    expect(verifySession(opened.session!.value, "second", NOW)).toBe(false);
    expect(db.rpcCalls.filter((c) => c.name === "sign_envelope_rotate_token")).toHaveLength(1);
    expect(db.rpcCalls.filter((c) => c.name === "sign_rotate_token")).toHaveLength(0);
  });

  it("works when the document asks for no code, and when the server has no key to sign a session with (the page then asks for the code)", async () => {
    db.seed("sign_documents", [doc("d1", { code_required: false })]);
    db.seed("sign_signers", [signer("s1", "d1")]);
    expect((await openCountersign(ctxFor(DIRECTOR), "d1", meta)).session).not.toBeNull();
    delete process.env.ENCRYPTION_KEY;
    expect((await openCountersign(ctxFor(DIRECTOR), "d1", meta)).session).toBeNull();
  });

  it("refuses someone who is not a Halo-user signer on the document: 403, the same answer whether or not the document exists", async () => {
    db.seed("sign_documents", [doc("d1")]);
    db.seed("sign_signers", [signer("s1", "d1"), signer("out", "d1", { internal_user_id: null, email: "ali@example.com" })]);
    expect(await code(openCountersign(ctxFor(SOMEONE), "d1", meta))).toEqual({ code: "not_a_signer", status: 403 });
    expect(await code(openCountersign(ctxFor(SENDER), "d1", meta))).toEqual({ code: "not_a_signer", status: 403 });
    expect(await code(openCountersign(ctxFor(DIRECTOR), "no-such-document", meta))).toEqual({ code: "not_a_signer", status: 403 });
    expect(db.rpcCalls.filter((c) => c.name === "sign_rotate_token")).toHaveLength(0);
    expect(tokens.size).toBe(0);
  });

  it("can never mint a link for someone else: another Halo user, or a user of another workspace, gets nothing and changes nothing", async () => {
    db.seed("sign_documents", [doc("d1")]);
    db.seed("sign_signers", [signer("s1", "d1")]);
    tokens.set("s1", "the-directors-link");
    // a colleague, the sender, and the same user id presented in another workspace
    for (const ctx of [ctxFor(SOMEONE), ctxFor(SENDER), ctxFor(DIRECTOR, OTHER_ACCT)]) {
      expect(await code(openCountersign(ctx, "d1", meta))).toEqual({ code: "not_a_signer", status: 403 });
    }
    expect(tokens.get("s1")).toBe("the-directors-link");
    expect(events).toEqual([]);
  });

  it("refuses with 409 when it is not their turn yet (an ordered document, their step has not begun)", async () => {
    db.seed("sign_documents", [doc("d1", { sign_in_order: true })]);
    db.seed("sign_signers", [signer("s0", "d1", { internal_user_id: null, order_no: 1 }), signer("s1", "d1", { order_no: 2, status: "pending" })]);
    expect(await code(openCountersign(ctxFor(DIRECTOR), "d1", meta))).toEqual({ code: "not_your_turn", status: 409 });
    expect(db.rpcCalls.filter((c) => c.name === "sign_rotate_token")).toHaveLength(0);
  });

  it("refuses with 409 when the document is not open: draft, finished, cancelled, expired or past its date", async () => {
    for (const [status, expires] of [["draft", iso(10)], ["completed", iso(10)], ["voided", iso(10)], ["expired", iso(-1)], ["declined", iso(10)], ["sealing", iso(10)], ["sent", iso(-1)]] as const) {
      db.tables = { profiles: db.tables.profiles };
      db.seed("sign_documents", [doc("d1", { status, expires_at: expires })]);
      db.seed("sign_signers", [signer("s1", "d1", { status: status === "draft" ? "pending" : "sent" })]);
      expect(await code(openCountersign(ctxFor(DIRECTOR), "d1", meta)), `${status} ${expires}`).toEqual({ code: "document_not_open", status: 409 });
    }
    expect(tokens.size).toBe(0);
  });

  it("refuses with 409 when they have already signed, and when they declined", async () => {
    db.seed("sign_documents", [doc("d1"), doc("d2")]);
    db.seed("sign_signers", [signer("s1", "d1", { status: "signed" }), signer("s2", "d2", { status: "declined" })]);
    expect(await code(openCountersign(ctxFor(DIRECTOR), "d1", meta))).toEqual({ code: "already_signed", status: 409 });
    expect(await code(openCountersign(ctxFor(DIRECTOR), "d2", meta))).toEqual({ code: "signer_not_open", status: 409 });
    expect(events).toEqual([]);
  });

  it("with two roles on one document it opens the one whose turn it is, and says 'not yet' rather than 'signed' when one is still ahead", async () => {
    db.seed("sign_documents", [doc("d1", { sign_in_order: true }), doc("d2", { sign_in_order: true })]);
    db.seed("sign_signers", [
      signer("a1", "d1", { role_key: "merchant", order_no: 1, status: "signed" }),
      signer("a2", "d1", { order_no: 2, status: "sent" }),
      signer("b1", "d2", { role_key: "merchant", order_no: 1, status: "signed" }),
      signer("b2", "d2", { order_no: 2, status: "pending" }),
    ]);
    expect((await openCountersign(ctxFor(DIRECTOR), "d1", meta)).signerId).toBe("a2");
    expect(await code(openCountersign(ctxFor(DIRECTOR), "d2", meta))).toEqual({ code: "not_your_turn", status: 409 });
  });

  it("turns a refusal by the database (someone signed in the meantime) into the same 409, and needs a signed-in person", async () => {
    db.seed("sign_documents", [doc("d1")]);
    db.seed("sign_signers", [signer("s1", "d1")]);
    db.rpcHandlers.sign_rotate_token = async () => ({ data: null, error: { message: "signer_not_open" } });
    expect(await code(openCountersign(ctxFor(DIRECTOR), "d1", meta))).toEqual({ code: "signer_not_open", status: 409 });
    expect(events).toEqual([]);
    await expect(openCountersign(ctxFor(null), "d1", meta)).rejects.toMatchObject({ status: 401 });
  });
});

describe("assertAccountMembers", () => {
  it("accepts people of this workspace and refuses an id from anywhere else", async () => {
    db.seed("profiles", [{ user_id: "stranger", account_id: OTHER_ACCT, full_name: "Stranger" }]);
    await expect(assertAccountMembers(ctxFor(SENDER), [DIRECTOR, SOMEONE, DIRECTOR])).resolves.toBeUndefined();
    await expect(assertAccountMembers(ctxFor(SENDER), [])).resolves.toBeUndefined();
    await expect(assertAccountMembers(ctxFor(SENDER), [DIRECTOR, "stranger"])).rejects.toMatchObject({ code: "signer_internal_user", status: 400 });
    await expect(assertAccountMembers(ctxFor(SENDER), ["nobody"])).rejects.toMatchObject({ status: 400 });
  });
});

describe("listNeedsAttention", () => {
  const ev = (documentId: string, seq: number, type: string, signerId: string | null, detail: Record<string, unknown> = {}) => ({ account_id: ACCT, document_id: documentId, doc_seq: seq, signer_id: signerId, type, detail, created_at: iso(-1 + seq / 1000) });

  it("lists declined and expired documents of the last 30 days and any that failed to seal, with who is concerned, and nothing else that stopped", async () => {
    db.seed("sign_documents", [
      doc("declined", { status: "declined", updated_at: iso(-2) }),
      doc("expired", { status: "expired", updated_at: iso(-3) }),
      doc("failed", { status: "failed", updated_at: iso(-90) }),
      doc("old-declined", { status: "declined", updated_at: iso(-45) }),
      doc("voided", { status: "voided", updated_at: iso(-1) }),
      doc("completed", { status: "completed", updated_at: iso(-1) }),
      doc("draft", { status: "draft", updated_at: iso(-1) }),
      doc("other-workspace", { status: "declined", updated_at: iso(-1), account_id: OTHER_ACCT }),
    ]);
    db.seed("sign_signers", [
      signer("a", "declined", { internal_user_id: null, full_name: "Ali", status: "declined" }),
      signer("b", "expired", { internal_user_id: null, full_name: "Siti", status: "sent" }),
      signer("c", "expired", { internal_user_id: null, full_name: "Lim", status: "signed" }),
    ]);
    const items = await listNeedsAttention(ctxFor(SENDER));
    expect(items.map((i) => [i.documentId, i.reasons, i.people])).toEqual([
      ["declined", ["declined"], ["Ali"]],
      ["expired", ["expired"], ["Siti"]],
      ["failed", ["failed"], []],
    ]);
  });

  it("lists an open document whose message did not arrive, until a reminder, a new link or a changed recipient goes through", async () => {
    db.seed("sign_documents", [doc("stuck"), doc("fixed"), doc("fixed-then-failed"), doc("completed-copy"), doc("signed-since")]);
    db.seed("sign_signers", [
      signer("s1", "stuck", { internal_user_id: null, full_name: "Ali" }),
      signer("s2", "fixed", { internal_user_id: null, full_name: "Siti" }),
      signer("s3", "fixed-then-failed", { internal_user_id: null, full_name: "Lim" }),
      signer("s4", "completed-copy", { internal_user_id: null, full_name: "Wong" }),
      signer("s5", "signed-since", { internal_user_id: null, full_name: "Tan", status: "signed" }),
    ]);
    db.seed("sign_events", [
      ev("stuck", 2, "invited", "s1"),
      ev("stuck", 3, "delivery_failed", "s1", { channel: "email" }),
      ev("fixed", 2, "invited", "s2"),
      ev("fixed", 3, "delivery_failed", "s2"),
      ev("fixed", 4, "reminded", "s2"),
      ev("fixed-then-failed", 3, "delivery_failed", "s3"),
      ev("fixed-then-failed", 4, "resent", "s3"),
      ev("fixed-then-failed", 5, "delivery_failed", "s3"),
      // a failure to deliver the signed copy is not about getting someone to sign
      ev("completed-copy", 3, "delivery_failed", "s4", { kind: "completed" }),
      ev("signed-since", 3, "delivery_failed", "s5"),
    ]);
    const items = await listNeedsAttention(ctxFor(SENDER));
    expect(items.map((i) => [i.documentId, i.reasons, i.people])).toEqual([
      ["fixed-then-failed", ["undelivered"], ["Lim"]],
      ["stuck", ["undelivered"], ["Ali"]],
    ]);
  });

  it("shows nothing of another workspace and nothing when all is well", async () => {
    db.seed("sign_documents", [doc("fine"), doc("theirs", { account_id: OTHER_ACCT, status: "declined", updated_at: iso(-1) })]);
    db.seed("sign_signers", [signer("s1", "fine", { internal_user_id: null })]);
    db.seed("sign_events", [{ ...ev("theirs", 3, "delivery_failed", "x"), account_id: OTHER_ACCT }]);
    expect(await listNeedsAttention(ctxFor(SENDER))).toEqual([]);
    expect((await listNeedsAttention(ctxFor(SENDER, OTHER_ACCT))).map((i) => i.documentId)).toEqual(["theirs"]);
  });
});
