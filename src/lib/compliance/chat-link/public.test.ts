/* eslint-disable @typescript-eslint/no-explicit-any -- rows and bodies are read loosely in a test */
// The personal closure form (/c/link/<token>) against the in-memory database: drawing the page, the one calm answer for every link that does not work, and the
// submission: no emailed code, the email typed, the masked phone, the SAME closure rules as the public form, the files, the case UPDATED (never a new one),
// the protected answers encrypted, the claim made once, the notification and the note. The SQL claim itself is proved by verify-185.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectFileKind } from "@/lib/net/file-kind";
import { openSensitive } from "../secrets";
import { issueFormToken } from "@/lib/sign/registration/token";
import type { FakeDb } from "@/lib/sign/service/fake-db";

import type { PublicEnv } from "../public/service";
import { ACCOUNT, ACCOUNT_NUMBER, AGENT, HEAD, publicWorld } from "../test-support";
import { findLink, loadLinkPage, submitLinkForm, type LinkSubmitRequest } from "./public";
import { installLinkRpc } from "./test-support";
import { mintLinkToken } from "./token";

const CONV = "c1000000-0000-4000-8000-000000000001";
const CONTACT = "e1000000-0000-4000-8000-000000000001";
const REQ = "d1000000-0000-4000-8000-000000000001";
const LINK = "b1000000-0000-4000-8000-000000000001";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

let db: FakeDb;
let nowMs: number;
let token: string;
let denied: Set<string>;
let emailsSent: number;

const env = (): PublicEnv => ({
  admin: db.client(),
  now: () => new Date(nowMs),
  limit: async (key) => ![...denied].some((d) => key.startsWith(d)),
  captcha: { enabled: false, verify: async () => true },
  notices: { mail: { emailConfigured: () => true, sendEmail: async () => void (emailsSent += 1), loadIdentity: async () => ({}) } as never, now: () => new Date(nowMs) },
});
const cases = () => db.rows("compliance_requests") as any[];
const links = () => db.rows("compliance_form_links") as any[];
const theCase = () => cases().find((c) => c.id === REQ) as any;
const events = () => (db.rows("compliance_request_events") as any[]).filter((e) => e.request_id === REQ);

async function mint(id = LINK, over: Record<string, unknown> = {}) {
  const m = mintLinkToken(id)!;
  const { error } = await db.client().rpc("compliance_mint_form_link", { p_request: REQ, p_actor: AGENT, p_link: id, p_token_hash: m.tokenHash, p_conversation: CONV, p_channel: "whatsapp", p_locale: "ms", p_ttl_days: 14, ...over });
  expect(error).toBeNull();
  return m.token;
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = publicWorld();
  nowMs = Date.UTC(2026, 9, 13, 10, 0, 0);
  denied = new Set();
  emailsSent = 0;
  installLinkRpc(db, { now: () => nowMs });
  db.seed("contacts", [{ id: CONTACT, account_id: ACCOUNT, name: "Siti Aminah", phone: "+60123456881", email: "siti.contact@example.test", language: "ms", deleted_at: null }]);
  db.seed("conversations", [{ id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp" }]);
  db.seed("compliance_requests", [
    { id: REQ, account_id: ACCOUNT, reference: "CMP-2026-000001", type_key: "closure", status: "received", source: "inbox", channel: "whatsapp", customer_name: "Siti Aminah", customer_email: null, customer_phone: "+60123456881", conversation_id: CONV, contact_id: CONTACT, created_by: AGENT, identity_check: {}, data: { reason: "Moving abroad" }, data_enc: null, customer_locale: null, retention_until: "2033-10-13T00:00:00Z" },
  ]);
  token = await mint();
});

const pageToken = (ageMs = 60_000, id = LINK) => issueFormToken(id, new Date(nowMs - ageMs))!;
const body = (over: Record<string, unknown> = {}) => ({
  linkToken: token,
  token: pageToken(),
  email: "Siti.Typed@Example.test",
  locale: "ms",
  wantClose: "yes",
  name: "Siti Aminah binti Yusof",
  phone: "",
  childrenFinished: true,
  allowancesStopped: true,
  reason: "",
  bankChoice: "Maybank",
  accountNumber: ACCOUNT_NUMBER,
  accountHolder: "SITI AMINAH BT YUSOF",
  declaration: true,
  website: "",
  ...over,
});
const submit = (over: Record<string, unknown> = {}, files: LinkSubmitRequest["files"] = {}, e = env()) => submitLinkForm(e, { body: body(over), files, ip: "203.0.113.9" }, detectFileKind);

describe("drawing the page", () => {
  it("shows the form with the phone masked, the name and the email as suggestions, and the language of the card", async () => {
    const out = await loadLinkPage(env(), token, "203.0.113.9", "en");
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.view).toMatchObject({ linkToken: token, maskedPhone: "+6012••••881", name: "Siti Aminah", email: "siti.contact@example.test", locale: "ms", workspace: { name: "Vircle" }, targetDays: 14 });
    expect(out.view.token).toContain(LINK);
    expect(out.view.banks.length).toBeGreaterThan(5);
    // the whole phone number, the bank details and the case's reference are not on the page
    const json = JSON.stringify(out.view);
    expect(json).not.toContain("123456881");
    expect(json).not.toContain("CMP-");
  });

  it("asks for the phone number when the case has none", async () => {
    theCase().customer_phone = null;
    const out = await loadLinkPage(env(), token, "203.0.113.9", "en");
    expect(out.kind === "ok" && out.view.maskedPhone).toBeNull();
  });

  it("records that it was opened, once", async () => {
    await loadLinkPage(env(), token, "203.0.113.9", null);
    await loadLinkPage(env(), token, "203.0.113.9", null);
    expect(links()[0].opened_at).not.toBeNull();
    expect(events().filter((e) => e.detail?.action === "opened")).toHaveLength(1);
  });

  it("falls back to the contact's language, then the visitor's browser, when the link has none", async () => {
    links()[0].locale = null;
    expect((await loadLinkPage(env(), token, "203.0.113.9", "ko") as any).view.locale).toBe("ms");
    db.rows("contacts")[0].language = null;
    expect((await loadLinkPage(env(), token, "203.0.113.9", "ko") as any).view.locale).toBe("ko");
    expect((await loadLinkPage(env(), token, "203.0.113.9", null) as any).view.locale).toBe("en");
  });

  it("is busy when the caller has asked too often", async () => {
    denied.add("cmp:link:att:ip:");
    expect(await loadLinkPage(env(), token, "203.0.113.9", null)).toEqual({ kind: "busy" });
    denied.clear();
    denied.add("cmp:link:att:link:");
    expect(await loadLinkPage(env(), token, "203.0.113.9", null)).toEqual({ kind: "busy" });
  });
});

describe("one calm answer for every link that does not work", () => {
  const gone = async (t: string = token) => {
    const page = await loadLinkPage(env(), t, "203.0.113.9", "en");
    const post = await submit({ linkToken: t });
    return { page, post };
  };

  it("is the same for a made-up link, a wrong secret, a used one, a withdrawn one, a replaced one and an expired one", async () => {
    const wrongSecret = `${token.split(".")[0]}.${"A".repeat(43)}`;
    const unknown = `${"0".repeat(32)}.${"A".repeat(43)}`;
    const results: unknown[] = [];
    results.push(await gone("nonsense"), await gone(unknown), await gone(wrongSecret));
    // used
    links()[0].submitted_at = "2026-10-13T09:00:00Z";
    results.push(await gone());
    // withdrawn
    links()[0].submitted_at = null;
    links()[0].revoked_at = "2026-10-13T09:00:00Z";
    links()[0].revoked_reason = "revoked";
    results.push(await gone());
    // replaced
    links()[0].revoked_reason = "replaced";
    results.push(await gone());
    // expired
    links()[0].revoked_at = null;
    links()[0].revoked_reason = null;
    nowMs += 15 * 86_400_000;
    results.push(await gone());
    for (const r of results as { page: unknown; post: unknown }[]) {
      expect(r.page).toEqual({ kind: "invalid" });
      expect(r.post).toEqual({ kind: "not_found" });
    }
    // none of them changed the case
    expect(theCase().customer_email).toBeNull();
  });

  it("is the same when the workspace has Compliance off, when the case has moved on, or when it is closed or not a closure", async () => {
    (db.rows("account_platform")[0] as any).features = { compliance: false };
    expect((await gone()).page).toEqual({ kind: "invalid" });
    (db.rows("account_platform")[0] as any).features = { compliance: true };
    expect((await gone()).page.kind).toBe("ok");
    theCase().status = "awaiting_signoff";
    expect(await gone()).toEqual({ page: { kind: "invalid" }, post: { kind: "not_found" } });
    theCase().status = "closed";
    expect((await gone()).page).toEqual({ kind: "invalid" });
    theCase().status = "received";
    theCase().type_key = "withdrawal";
    expect((await gone()).page).toEqual({ kind: "invalid" });
  });

  it("is the same when the closure type cannot take the form's fields", async () => {
    const type = (db.rows("compliance_request_types") as any[]).find((t) => t.key === "closure");
    type.fields = type.fields.filter((f: any) => f.key !== "bank_account_number");
    expect(await gone()).toEqual({ page: { kind: "invalid" }, post: { kind: "not_found" } });
  });

  it("finds a link only by its own token", async () => {
    expect((await findLink(db.client(), token, new Date(nowMs)))?.link.id).toBe(LINK);
    expect(await findLink(db.client(), undefined, new Date(nowMs))).toBeNull();
    expect(await findLink(db.client(), 42, new Date(nowMs))).toBeNull();
    // a second link for the same case: the first one's token no longer works
    const second = await mint("b1000000-0000-4000-8000-000000000002");
    expect(await findLink(db.client(), token, new Date(nowMs))).toBeNull();
    expect((await findLink(db.client(), second, new Date(nowMs)))?.link.id).toBe("b1000000-0000-4000-8000-000000000002");
  });
});

describe("filling in the form", () => {
  it("updates the EXISTING case: the name, the email typed, the answers merged, the bank details encrypted, the language", async () => {
    const r = await submit();
    expect(r).toEqual({ kind: "ok", reference: "CMP-2026-000001" });
    expect(cases()).toHaveLength(1);
    const c = theCase();
    expect(c).toMatchObject({ customer_name: "Siti Aminah binti Yusof", customer_email: "siti.typed@example.test", customer_phone: "+60123456881", customer_locale: "ms", status: "received", source: "inbox", created_by: AGENT });
    // the ordinary answers are merged into what the agent had; the protected ones are NOT in data
    expect(c.data).toMatchObject({ reason: "Moving abroad", confirm_closure: true, children_finished_school: true, allowances_cancelled: true, declaration: true });
    expect(JSON.stringify(c.data)).not.toContain(ACCOUNT_NUMBER);
    expect(c.data_enc).toEqual(expect.any(String));
    expect(c.data_enc).not.toContain(ACCOUNT_NUMBER);
    expect(openSensitive(REQ, c.data_enc)).toEqual({ bank_name: "Maybank", bank_account_number: ACCOUNT_NUMBER, bank_account_holder: "SITI AMINAH BT YUSOF" });
  });

  it("leaves the identity check NOT done, and the email not proved", async () => {
    await submit();
    expect(theCase().identity_check).toEqual({});
    expect(theCase().email_verified_at ?? null).toBeNull();
    expect(theCase().status).toBe("received");
  });

  it("needs no emailed code and no session: nothing is asked for, nothing stored for one, and no email is sent", async () => {
    expect((await submit()).kind).toBe("ok");
    expect(db.rows("compliance_email_codes")).toHaveLength(0);
    expect(emailsSent).toBe(0);
  });

  it("marks the link used and writes one form_submitted event naming only the link", async () => {
    await submit();
    expect(links()[0].submitted_at).not.toBeNull();
    const ev = events().filter((e) => e.kind === "form_submitted");
    expect(ev).toHaveLength(1);
    expect(ev[0].actor).toBeNull();
    expect(JSON.stringify(ev)).not.toMatch(/Siti|example\.test|Maybank|8800/);
    expect(JSON.stringify(events())).not.toContain(ACCOUNT_NUMBER);
  });

  it("applies once: a second submission with the same link gets the neutral answer and changes nothing", async () => {
    expect((await submit()).kind).toBe("ok");
    const after = JSON.stringify(theCase());
    const again = await submit({ name: "Someone Else", email: "other@example.test", reason: "changed" });
    expect(again).toEqual({ kind: "not_found" });
    expect(JSON.stringify(theCase())).toBe(after);
    expect(events().filter((e) => e.kind === "form_submitted")).toHaveLength(1);
  });

  it("applies once when two arrive together", async () => {
    const [a, b] = await Promise.all([submit(), submit({ reason: "second" })]);
    expect([a.kind, b.kind].sort()).toEqual(["not_found", "ok"]);
    expect(events().filter((e) => e.kind === "form_submitted")).toHaveLength(1);
    expect((db.rows("messages") as any[]).filter((m) => /Closure form submitted/.test(m.content_text))).toHaveLength(1);
  });

  it("tells the people who review closures, and leaves a line on the conversation", async () => {
    await submit();
    const n = db.rows("notifications") as any[];
    expect(n.map((x) => x.user_id)).toEqual([HEAD]);
    expect(n[0]).toMatchObject({ account_id: ACCOUNT, type: "compliance_form", compliance_request_id: REQ });
    expect(n[0].title).toContain("CMP-2026-000001");
    expect(JSON.stringify(n)).not.toMatch(/Siti|example\.test|Maybank/);
    const note = (db.rows("messages") as any[]).find((m) => /Closure form submitted/.test(m.content_text));
    expect(note).toMatchObject({ conversation_id: CONV, is_internal: true, sender_id: AGENT, content_text: "Closure form submitted · CMP-2026-000001" });
  });

  it("still succeeds when the notification or the note cannot be written", async () => {
    db.failNext.notifications = "boom";
    db.failNext.messages = "boom";
    expect(await submit()).toEqual({ kind: "ok", reference: "CMP-2026-000001" });
  });

  it("answers with the reference and nothing the parent typed", async () => {
    const r = await submit();
    expect(Object.keys(r).sort()).toEqual(["kind", "reference"]);
    expect(JSON.stringify(r)).not.toMatch(/Siti|example|8800|Maybank/);
  });
});

describe("the same rules as the public closure form", () => {
  it("needs the acknowledgements and the declaration", async () => {
    expect(await submit({ childrenFinished: false, allowancesStopped: false, declaration: false })).toEqual({
      kind: "invalid",
      problems: { childrenFinished: "must_acknowledge", allowancesStopped: "must_acknowledge", declaration: "must_acknowledge" },
    });
    expect(links()[0].submitted_at).toBeNull();
    expect(theCase().customer_email).toBeNull();
  });

  it("needs the name, the bank and the account", async () => {
    const r = await submit({ name: "", bankChoice: "", accountNumber: "12", accountHolder: "" });
    expect(r).toMatchObject({ kind: "invalid", problems: { name: "required", bankChoice: "required", accountNumber: "invalid", accountHolder: "required" } });
  });

  it("needs an email address that looks like one, and has no use for a code", async () => {
    expect(await submit({ email: "" })).toMatchObject({ kind: "invalid", problems: { email: "required" } });
    expect(await submit({ email: "not an email" })).toMatchObject({ kind: "invalid", problems: { email: "invalid" } });
    expect(await submit({ email: undefined })).toMatchObject({ kind: "invalid", problems: { email: "required" } });
  });

  it("asks for an authorization letter only when the bank holder's name differs, and checks the file by its bytes", async () => {
    const diff = { accountHolder: "Ahmad bin Ali" };
    expect(await submit(diff)).toMatchObject({ kind: "invalid", problems: { letter: "file_required" } });
    expect(await submit(diff, { letter: { bytes: HTML, name: "letter.pdf" } })).toMatchObject({ kind: "invalid", problems: { letter: "file_type" } });
    expect(await submit(diff, { letter: { bytes: new Uint8Array(10 * 1024 * 1024 + 1).fill(1), name: "big.pdf" } })).toMatchObject({ kind: "invalid", problems: { letter: "file_size" } });
    expect(links()[0].submitted_at).toBeNull();
    expect(db.files.size).toBe(0);
    expect((await submit(diff, { letter: { bytes: PDF, name: "letter.pdf" } })).kind).toBe("ok");
    const files = db.rows("compliance_request_files") as any[];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ account_id: ACCOUNT, request_id: REQ, field_key: "authorization_letter", mime: "application/pdf", uploaded_by: null });
    expect(files[0].path).toMatch(new RegExp(`^account-${ACCOUNT}/${REQ}/`));
    expect(db.files.size).toBe(1);
  });

  it("does not need a letter when the names match despite titles and spelling", async () => {
    expect((await submit({ name: "Puan Siti Aminah binti Yusof", accountHolder: "SITI AMINAH BT YUSOF" })).kind).toBe("ok");
    expect(db.files.size).toBe(0);
  });

  it("removes the stored letter when the claim is refused (a link used a moment ago)", async () => {
    const diff = { accountHolder: "Ahmad bin Ali" };
    const attempt = submit(diff, { letter: { bytes: PDF, name: "letter.pdf" } });
    // another submission wins the claim while this one is storing its file
    links()[0].submitted_at = "2026-10-13T10:00:01Z";
    expect(await attempt).toEqual({ kind: "not_found" });
    expect(db.files.size).toBe(0);
    expect(db.rows("compliance_request_files")).toHaveLength(0);
  });

  it("takes 'No' as an answer: nothing changes and the link still works", async () => {
    expect(await submit({ wantClose: "no" })).toEqual({ kind: "declined" });
    expect(links()[0].submitted_at).toBeNull();
    expect(theCase().customer_email).toBeNull();
    expect((await submit()).kind).toBe("ok");
  });
});

describe("the phone number", () => {
  it("is not editable: what the form sends is ignored when the case already has the number", async () => {
    expect((await submit({ phone: "012-999 0000" })).kind).toBe("ok");
    expect(theCase().customer_phone).toBe("+60123456881");
  });

  it("is asked for, and checked, when the case has none", async () => {
    theCase().customer_phone = null;
    expect(await submit({ phone: "" })).toMatchObject({ kind: "invalid", problems: { phone: "required" } });
    expect(await submit({ phone: "12" })).toMatchObject({ kind: "invalid", problems: { phone: "invalid" } });
    expect((await submit({ phone: "012-334 4556" })).kind).toBe("ok");
    expect(theCase().customer_phone).toBe("+60123344556");
  });
});

describe("the guards", () => {
  it("answers a script that filled the hidden field like a success, and does nothing", async () => {
    expect(await submit({ website: "http://spam.example" })).toEqual({ kind: "ok", reference: null });
    expect(links()[0].submitted_at).toBeNull();
    expect(theCase().customer_email).toBeNull();
  });

  it("needs the page's own token: genuine, for THIS link, not too fast, not too old", async () => {
    expect(await submit({ token: undefined })).toMatchObject({ kind: "retry", code: "token_invalid" });
    expect(await submit({ token: pageToken(60_000, "b1000000-0000-4000-8000-0000000000ff") })).toMatchObject({ kind: "retry", code: "token_invalid" });
    expect(await submit({ token: pageToken(500) })).toMatchObject({ kind: "retry", code: "token_too_fast" });
    expect(await submit({ token: pageToken(3 * 3_600_000) })).toMatchObject({ kind: "retry", code: "token_expired" });
    const retry: any = await submit({ token: undefined });
    expect(retry.token).toContain(LINK);
    expect(theCase().customer_email).toBeNull();
  });

  it("is limited per caller address and per link, and before anything is changed", async () => {
    denied.add("cmp:link:att:ip:");
    expect(await submit()).toEqual({ kind: "rate_limited" });
    denied.clear();
    denied.add("cmp:link:att:link:");
    expect(await submit()).toEqual({ kind: "rate_limited" });
    denied.clear();
    denied.add("cmp:link:sub:ip:");
    expect(await submit()).toEqual({ kind: "rate_limited" });
    expect(links()[0].submitted_at).toBeNull();
    expect(theCase().customer_email).toBeNull();
  });

  it("counts a wrong token as an attempt too", async () => {
    denied.add("cmp:link:att:ip:");
    expect(await submit({ linkToken: "nonsense" })).toEqual({ kind: "rate_limited" });
  });

  it("fails calmly, and removes what it stored, when the database refuses", async () => {
    const diff = { accountHolder: "Ahmad bin Ali" };
    db.rpcHandlers.compliance_apply_form_link = () => ({ data: null, error: { message: "boom" } });
    expect(await submit(diff, { letter: { bytes: PDF, name: "letter.pdf" } })).toEqual({ kind: "failed" });
    expect(db.files.size).toBe(0);
  });
});
