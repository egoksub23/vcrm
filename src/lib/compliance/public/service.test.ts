/* eslint-disable @typescript-eslint/no-explicit-any -- rows and bodies are read loosely in a test */
// The public parent forms against the in-memory database and an injected sender: the form behind an address, asking for a code, entering it, and the
// submission with every guard (token, session, same address, honeypot, limits, acknowledgements, the letter, the files, one open request per address, the
// workspace wall for contacts). What lives in SQL (the unique index, the retention rules) is proved by supabase/ci/verify-184-compliance-intake.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceMailDeps } from "@/lib/email/workspace-mail";
import type { FakeDb } from "@/lib/sign/service/fake-db";
import { issueFormToken } from "@/lib/sign/registration/token";

import { ACCOUNT, ACCOUNT_NUMBER, FORM_CLOSURE, FORM_WITHDRAWAL, OTHER_ACCOUNT, SLUG_CLOSURE, SLUG_WITHDRAWAL, publicWorld } from "../test-support";
import { cleanEmail } from "./amount";
import { buildPublicView, loadPublicForm, matchContact, requestCode, submitPublicForm, verifyCode, typeSupportsPublicForm, type PublicEnv, type SubmitRequest } from "./service";
import { createSession, hashEmail, sessionCookieName } from "./session";
import { OTHER_BANK } from "./banks";

const EMAIL = "siti@example.test";
const CONTACT = "c0000000-0000-4000-8000-000000000001";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

let db: FakeDb;
let nowMs: number;
let sent: { to: string; subject: string; html: string; text: string }[];
let denied: Set<string>;
let mailFails: boolean;
let captcha: { enabled: boolean; ok: boolean; seen: (string | null)[] };

function env(admin = db.client()): PublicEnv {
  const mail: WorkspaceMailDeps = {
    emailConfigured: () => true,
    sendEmail: async (m: any) => {
      if (mailFails) throw new Error("smtp down");
      sent.push({ to: m.to, subject: m.subject, html: m.html, text: m.text });
    },
    loadIdentity: async () => ({ fromName: "Vircle", replyTo: null }),
  };
  return {
    admin,
    now: () => new Date(nowMs),
    limit: async (key) => ![...denied].some((d) => key.startsWith(d)),
    captcha: { enabled: captcha.enabled, verify: async (t) => (captcha.seen.push(t), captcha.ok) },
    notices: { mail, now: () => new Date(nowMs) },
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = publicWorld();
  nowMs = Date.now();
  sent = [];
  denied = new Set();
  mailFails = false;
  captcha = { enabled: false, ok: true, seen: [] };
});

const formRow = (id = FORM_CLOSURE) => db.rows("compliance_public_forms").find((f: any) => f.id === id) as any;
const cases = () => db.rows("compliance_requests") as any[];

const sessionFor = (formId: string, email = EMAIL, issuedAgoMs = 60_000) => createSession(formId, hashEmail(email)!, new Date(nowMs - issuedAgoMs))!.value;
const tokenFor = (formId: string, ageMs = 60_000) => issueFormToken(formId, new Date(nowMs - ageMs))!;

const closureBody = (over: Record<string, unknown> = {}) => ({
  token: tokenFor(FORM_CLOSURE),
  email: EMAIL,
  locale: "ms",
  wantClose: "yes",
  name: "Siti Aminah binti Yusof",
  phone: "012-334 4556",
  childrenFinished: true,
  allowancesStopped: true,
  reason: "Moving abroad",
  bankChoice: "Maybank",
  accountNumber: ACCOUNT_NUMBER,
  accountHolder: "SITI AMINAH BT YUSOF",
  declaration: true,
  website: "",
  ...over,
});
const withdrawalBody = (over: Record<string, unknown> = {}) => ({
  token: tokenFor(FORM_WITHDRAWAL),
  email: EMAIL,
  locale: "en",
  name: "Siti Aminah",
  phone: "+60123344556",
  amount: "120.50",
  reasonKind: "over_topup",
  transactionRefs: "TX-1",
  bankChoice: OTHER_BANK,
  bankOther: "Bank of Elsewhere",
  accountNumber: "123456789",
  accountHolder: "Siti Aminah",
  declaration: true,
  ...over,
});

const submit = (over: Partial<SubmitRequest> = {}, e = env()) =>
  submitPublicForm(e, { slug: SLUG_CLOSURE, body: closureBody(), files: {}, sessionValue: sessionFor(FORM_CLOSURE), ip: "203.0.113.9", ...over });
const submitW = (over: Partial<SubmitRequest> = {}, e = env()) =>
  submitPublicForm(e, { slug: SLUG_WITHDRAWAL, body: withdrawalBody(), files: {}, sessionValue: sessionFor(FORM_WITHDRAWAL), ip: "203.0.113.9", ...over });

describe("the form behind an address", () => {
  it("is found by its slug when it is on, its workspace has the flag on and its type carries the form's fields", async () => {
    const found = await loadPublicForm(db.client(), SLUG_CLOSURE);
    expect(found).toMatchObject({ type: "closure", form: { id: FORM_CLOSURE } });
    expect(found?.workspace.name).toBe("Vircle");
    expect((await loadPublicForm(db.client(), SLUG_WITHDRAWAL))?.type).toBe("withdrawal");
  });

  it("is 'not available' for every reason alike: unknown, malformed, switched off, flag off, platform row missing, type inactive, fields missing", async () => {
    const a = db.client();
    expect(await loadPublicForm(a, "nothing-here-abc23456")).toBeNull();
    expect(await loadPublicForm(a, "../etc/passwd")).toBeNull();
    expect(await loadPublicForm(a, "")).toBeNull();
    formRow().enabled = false;
    expect(await loadPublicForm(a, SLUG_CLOSURE)).toBeNull();
    formRow().enabled = true;
    (db.rows("account_platform")[0] as any).features = { compliance: false };
    expect(await loadPublicForm(a, SLUG_CLOSURE)).toBeNull();
    (db.rows("account_platform")[0] as any).features = {};
    expect(await loadPublicForm(a, SLUG_CLOSURE)).toBeNull();
    (db.rows("account_platform")[0] as any).features = { compliance: true };
    (db.rows("account_platform")[0] as any).status = "suspended";
    expect(await loadPublicForm(a, SLUG_CLOSURE)).toBeNull();
    (db.rows("account_platform")[0] as any).status = "active";
    expect(await loadPublicForm(a, SLUG_CLOSURE)).not.toBeNull();
    const closure = db.rows("compliance_request_types").find((t: any) => t.key === "closure") as any;
    closure.active = false;
    expect(await loadPublicForm(a, SLUG_CLOSURE)).toBeNull();
    closure.active = true;
    closure.fields = closure.fields.filter((f: any) => f.key !== "declaration");
    expect(await loadPublicForm(a, SLUG_CLOSURE)).toBeNull();
  });

  it("is never offered for a phone change", async () => {
    db.rows("compliance_public_forms").push({ id: "f-phone", account_id: ACCOUNT, type_key: "phone_change", enabled: true, slug: "phone-change-abc23456", notice: {}, turnstile: false, max_amount: 1, banks: null });
    expect(await loadPublicForm(db.client(), "phone-change-abc23456")).toBeNull();
  });

  it("knows which types can take it", () => {
    expect(typeSupportsPublicForm(null, "closure")).toBe(false);
  });

  it("builds a view with the notice per language, the bank list and the target, and nothing of any case", async () => {
    const found = (await loadPublicForm(db.client(), SLUG_CLOSURE))!;
    const v = buildPublicView(found, "tok", "site-key", true);
    expect(v).toMatchObject({ slug: SLUG_CLOSURE, type: "closure", notice: { en: "Read this first" }, targetDays: 14, token: "tok", captchaKey: null, sessionActive: true });
    expect(v.banks).toContain("Maybank");
    expect(JSON.stringify(v)).not.toContain(ACCOUNT);
    formRow().turnstile = true;
    expect(buildPublicView((await loadPublicForm(db.client(), SLUG_CLOSURE))!, "tok", "site-key", false).captchaKey).toBe("site-key");
  });
});

describe("asking for a code", () => {
  const ask = (body: Record<string, unknown> = { email: EMAIL }, slug = SLUG_CLOSURE, e = env()) => requestCode(e, { slug, body, ip: "203.0.113.9" });

  it("emails a six-digit code, stores only a hash of it and of the address, and hands back the address masked", async () => {
    const r = await ask({ email: "Siti@Example.test", locale: "zh" });
    expect(r).toEqual({ kind: "ok", emailMasked: "s•••@example.test" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(EMAIL);
    const code = /\b(\d{6})\b/.exec(sent[0].text)?.[1];
    expect(code).toBeTruthy();
    const row = db.rows("compliance_email_codes")[0] as any;
    expect(row).toMatchObject({ form_id: FORM_CLOSURE, account_id: ACCOUNT, attempts: 0 });
    expect(Date.parse(row.expires_at) - nowMs).toBe(15 * 60_000);
    expect(JSON.stringify(row)).not.toContain(code!);
    expect(JSON.stringify(row)).not.toContain("siti");
    expect(row.email_hash).toBe(hashEmail(EMAIL));
  });

  it("is 'not available' for an unknown address and says nothing about which", async () => {
    expect(await ask({ email: EMAIL }, "nothing-here-abc23456")).toEqual({ kind: "not_found" });
    formRow().enabled = false;
    expect(await ask()).toEqual({ kind: "not_found" });
    expect(sent).toHaveLength(0);
  });

  it("refuses an address that is not one, a hidden field that is filled (answered like a success, nothing sent), and the limits", async () => {
    expect(await ask({ email: "nope" })).toEqual({ kind: "invalid_email" });
    expect(await ask({ email: "a@b.co,c@d.co" })).toEqual({ kind: "invalid_email" });
    expect(await ask({ email: EMAIL, website: "http://spam" })).toMatchObject({ kind: "ok" });
    expect(sent).toHaveLength(0);
    denied.add("cmp:code:email");
    expect(await ask()).toEqual({ kind: "rate_limited" });
    denied.clear();
    denied.add("cmp:att:ip");
    expect(await ask()).toEqual({ kind: "rate_limited" });
    denied.clear();
    denied.add("cmp:code:ip");
    expect(await ask()).toEqual({ kind: "rate_limited" });
    denied.clear();
    denied.add("cmp:att:form");
    expect(await ask()).toEqual({ kind: "rate_limited" });
    expect(sent).toHaveLength(0);
  });

  it("checks Turnstile when the form and the operator turned it on, before any email is sent", async () => {
    formRow().turnstile = true;
    captcha.enabled = true;
    captcha.ok = false;
    expect(await ask({ email: EMAIL, captcha: "t1" })).toEqual({ kind: "captcha_failed" });
    expect(sent).toHaveLength(0);
    captcha.ok = true;
    expect(await ask({ email: EMAIL, captcha: "t2" })).toMatchObject({ kind: "ok" });
    expect(captcha.seen).toEqual(["t1", "t2"]);
    // Turnstile on for the operator but not for this form: not asked
    formRow().turnstile = false;
    captcha.seen.length = 0;
    await ask({ email: "other@example.test" });
    expect(captcha.seen).toHaveLength(0);
  });

  it("takes the code back when the email could not be sent, and says so", async () => {
    mailFails = true;
    expect(await ask()).toEqual({ kind: "send_failed" });
    expect((db.rows("compliance_email_codes")[0] as any).consumed_at).toBeTruthy();
  });

  it("makes an earlier code stop working when a new one is asked for", async () => {
    await ask();
    const first = /\b(\d{6})\b/.exec(sent[0].text)![1];
    await ask();
    const second = /\b(\d{6})\b/.exec(sent[1].text)![1];
    const e = env();
    expect(await verifyCode(e, { slug: SLUG_CLOSURE, body: { email: EMAIL, code: first }, ip: "1.1.1.1" })).toMatchObject({ kind: first === second ? "ok" : "wrong" });
  });
});

describe("entering the code", () => {
  const ask = () => requestCode(env(), { slug: SLUG_CLOSURE, body: { email: EMAIL }, ip: "203.0.113.9" });
  const codeSent = (i = sent.length - 1) => /\b(\d{6})\b/.exec(sent[i].text)![1];
  const enter = (code: string, email = EMAIL, e = env()) => verifyCode(e, { slug: SLUG_CLOSURE, body: { email, code }, ip: "203.0.113.9" });
  const wrongCode = () => (codeSent() === "000000" ? "111111" : "000000");

  it("confirms the address with the right code: an HttpOnly session for this form for an hour, carrying a hash, and the code is used up", async () => {
    await ask();
    const r = await enter(codeSent());
    expect(r).toMatchObject({ kind: "ok", emailMasked: "s•••@example.test" });
    if (r.kind !== "ok") throw new Error();
    expect(r.cookie.name).toBe(sessionCookieName(SLUG_CLOSURE));
    expect(r.cookie.maxAgeSeconds).toBe(3600);
    expect(r.cookie.value).not.toContain("siti");
    expect(await enter(codeSent())).toEqual({ kind: "no_code" });
  });

  it("counts a wrong code, tells how many tries are left, and stops after five", async () => {
    await ask();
    expect(await enter(wrongCode())).toEqual({ kind: "wrong", attemptsLeft: 4 });
    expect(await enter(wrongCode())).toEqual({ kind: "wrong", attemptsLeft: 3 });
    for (let i = 0; i < 2; i++) await enter(wrongCode());
    expect(await enter(wrongCode())).toEqual({ kind: "too_many_attempts" });
    // the right code no longer works once the tries are spent
    expect(await enter(codeSent())).toEqual({ kind: "too_many_attempts" });
    expect((db.rows("compliance_email_codes")[0] as any).attempts).toBe(5);
  });

  it("refuses an expired code, a code for another address and a code that was never asked for, all without leaking which", async () => {
    await ask();
    const code = codeSent();
    nowMs += 15 * 60_000 + 1000;
    expect(await enter(code)).toEqual({ kind: "expired" });
    nowMs -= 15 * 60_000 + 1000;
    expect(await enter(code, "someone.else@example.test")).toEqual({ kind: "no_code" });
    expect(await enter("12345")).toMatchObject({ kind: "wrong" });
    expect(await enter("abcdef")).toMatchObject({ kind: "wrong" });
    expect(await enter(code, "not an email")).toEqual({ kind: "invalid_email" });
  });

  it("is limited per caller address and unavailable for an unknown address", async () => {
    await ask();
    denied.add("cmp:att:ip");
    expect(await enter(codeSent())).toEqual({ kind: "rate_limited" });
    denied.clear();
    expect(await verifyCode(env(), { slug: "nothing-here-abc23456", body: { email: EMAIL, code: "123456" }, ip: "1.1.1.1" })).toEqual({ kind: "not_found" });
  });
});

describe("a submission", () => {
  it("makes the case: source form, channel web_form, the verified email, the language, the clocks; the bank answers only as ciphertext; identity check not done", async () => {
    const r = await submit();
    expect(r).toMatchObject({ kind: "ok", reference: expect.stringMatching(/^CMP-\d{4}-\d{6}$/) });
    expect(cases()).toHaveLength(1);
    const c = cases()[0];
    expect(c).toMatchObject({
      account_id: ACCOUNT,
      type_key: "closure",
      source: "form",
      channel: "web_form",
      status: "received",
      customer_name: "Siti Aminah binti Yusof",
      customer_email: EMAIL,
      customer_phone: "+60123344556",
      customer_locale: "ms",
      created_by: null,
      contact_id: null,
    });
    expect(c.email_verified_at).toBe(new Date(Math.floor((nowMs - 60_000) / 1000) * 1000).toISOString());
    expect(c.identity_check).toEqual({});
    expect(c.data).toMatchObject({ confirm_closure: true, children_finished_school: true, allowances_cancelled: true, declaration: true, reason: "Moving abroad" });
    expect(c.data).not.toHaveProperty("bank_account_number");
    expect(typeof c.data_enc).toBe("string");
    for (const secret of [ACCOUNT_NUMBER, "SITI AMINAH BT YUSOF", "Maybank"]) expect(JSON.stringify(db.tables)).not.toContain(secret);
  });

  it("sends the parent the confirmation in the language they chose: the reference, no bank detail, no phone number, no staff link, no 30-day stop", async () => {
    const r = await submit();
    if (r.kind !== "ok") throw new Error();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(EMAIL);
    expect(sent[0].subject).toContain(r.reference!);
    const body = sent[0].text + sent[0].html;
    expect(body).toContain("14 hari");
    for (const bad of [ACCOUNT_NUMBER, "8800", "Maybank", "+6012", "012-334", "hard stop", "30 hari", "/compliance", "http"]) expect(body).not.toContain(bad);
    const notice = (db.rows("compliance_notices") as any[])[0];
    expect(notice).toMatchObject({ kind: "received", key: "once", audience: "customer", status: "sent", language: "ms" });
    const ev = (db.rows("compliance_request_events") as any[]).filter((e) => e.kind === "notice");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ notice: "received", status: "sent", audience: "customer" });
    expect(JSON.stringify(ev)).not.toContain(EMAIL);
  });

  it("answers with the reference and masks nothing it stored: the response never carries the answers back", async () => {
    const r = await submit();
    expect(Object.keys(r).sort()).toEqual(["kind", "reference"]);
  });

  it("does not fail the person when the confirmation email cannot be sent: the case exists and the failure is recorded", async () => {
    mailFails = true;
    const r = await submit();
    expect(r).toMatchObject({ kind: "ok" });
    expect(cases()).toHaveLength(1);
    expect((db.rows("compliance_notices")[0] as any).status).toBe("failed");
    const ev = (db.rows("compliance_request_events") as any[]).find((e) => e.kind === "notice");
    expect(ev.detail).toMatchObject({ status: "failed" });
  });

  it("REFUSES a closure without the school or allowance acknowledgement, or the declaration, and creates nothing", async () => {
    for (const k of ["childrenFinished", "allowancesStopped", "declaration"]) {
      const r = await submit({ body: closureBody({ [k]: false }) });
      expect(r).toMatchObject({ kind: "invalid", problems: { [k]: "must_acknowledge" } });
    }
    expect(cases()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("'No, I do not want to close' creates no case", async () => {
    expect(await submit({ body: closureBody({ wantClose: "no" }) })).toEqual({ kind: "declined" });
    expect(cases()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("needs an authorization letter exactly when the bank holder name differs, and keeps it in the private bucket tied to the case", async () => {
    const body = closureBody({ accountHolder: "Ahmad Yusof" });
    expect(await submit({ body })).toMatchObject({ kind: "invalid", problems: { letter: "file_required" } });
    expect(cases()).toHaveLength(0);
    const r = await submit({ body: closureBody({ accountHolder: "Ahmad Yusof" }), files: { letter: { bytes: PDF, name: "letter.pdf" } } });
    expect(r).toMatchObject({ kind: "ok" });
    const files = db.rows("compliance_request_files") as any[];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ account_id: ACCOUNT, request_id: cases()[0].id, field_key: "authorization_letter", mime: "application/pdf", uploaded_by: null });
    expect(files[0].path.startsWith(`account-${ACCOUNT}/${cases()[0].id}/`)).toBe(true);
    expect([...db.files.keys()]).toEqual([files[0].path]);
  });

  it("does not ask for the letter when the names agree once case, titles and bt/bin are set aside", async () => {
    expect(await submit({ body: closureBody({ accountHolder: "Puan Siti Aminah Yusof" }) })).toMatchObject({ kind: "ok" });
  });

  it("checks an upload by its first bytes and its size before anything is stored", async () => {
    const body = () => closureBody({ accountHolder: "Ahmad Yusof" });
    expect(await submit({ body: body(), files: { letter: { bytes: HTML, name: "letter.pdf" } } })).toMatchObject({ kind: "invalid", problems: { letter: "file_type" } });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    expect(await submit({ body: body(), files: { letter: { bytes: big, name: "big.pdf" } } })).toMatchObject({ kind: "invalid", problems: { letter: "file_size" } });
    expect(await submit({ body: body(), files: { letter: { bytes: new Uint8Array(0), name: "empty.pdf" } } })).toMatchObject({ kind: "invalid", problems: { letter: "file_required" } });
    expect(cases()).toHaveLength(0);
    expect(db.files.size).toBe(0);
  });

  it("makes no case when the letter cannot be stored", async () => {
    const admin = db.client();
    const failing = new Proxy(admin, {
      get(target, prop) {
        if (prop === "storage") return { from: () => ({ upload: async () => ({ data: null, error: { message: "bucket missing" } }), remove: async () => ({ data: [], error: null }) }) };
        return (target as any)[prop];
      },
    });
    const r = await submit({ body: closureBody({ accountHolder: "Ahmad Yusof" }), files: { letter: { bytes: PDF, name: "letter.pdf" } } }, env(failing as any));
    expect(r).toEqual({ kind: "failed" });
    expect(cases()).toHaveLength(0);
  });

  it("takes a withdrawal with an optional proof, the amount as a number and the reason in words", async () => {
    const r = await submitW({ files: { proof: { bytes: PNG, name: "screenshot.png" } } });
    expect(r).toMatchObject({ kind: "ok" });
    const c = cases()[0];
    expect(c).toMatchObject({ type_key: "withdrawal", source: "form", customer_locale: "en", customer_phone: "+60123344556" });
    expect(c.data).toMatchObject({ amount: 120.5, reason_kind: "over_topup", reason: "Over top-up", transaction_refs: "TX-1", declaration: true });
    expect((db.rows("compliance_request_files")[0] as any).field_key).toBe("proof");
    expect(sent[0].text).not.toContain("14");
    expect(JSON.stringify(db.tables)).not.toContain("Bank of Elsewhere");
  });

  it("refuses a withdrawal amount over the form's maximum", async () => {
    expect(await submitW({ body: withdrawalBody({ amount: "5000.01" }) })).toMatchObject({ kind: "invalid", problems: { amount: "too_large" } });
    expect(await submitW({ body: withdrawalBody({ amount: "5000" }) })).toMatchObject({ kind: "ok" });
  });

  it("answers a repeat like a first request: the same confirmation, the request the person already has, nothing created and no second email", async () => {
    const first = await submit();
    const again = await submit({ body: closureBody({ token: tokenFor(FORM_CLOSURE, 90_000) }) });
    expect(again).toEqual(first);
    expect(cases()).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // a different type is a different request
    expect(await submitW()).toMatchObject({ kind: "ok" });
    expect(cases()).toHaveLength(2);
  });

  it("counts an open request a member of staff raised for the same address, and a finished one no longer stops a new request", async () => {
    db.seed("compliance_requests", [{ id: "staff-1", account_id: ACCOUNT, reference: "CMP-2026-000090", type_key: "closure", source: "staff", status: "officer_review", customer_email: "SITI@example.test", customer_name: "x" }]);
    expect(await submit()).toEqual({ kind: "ok", reference: "CMP-2026-000090" });
    expect(cases()).toHaveLength(1);
    (cases()[0] as any).status = "rejected";
    const r = await submit();
    expect(r).toMatchObject({ kind: "ok" });
    expect((r as any).reference).not.toBe("CMP-2026-000090");
    expect(cases()).toHaveLength(2);
  });

  it("treats two posts at the same moment as one request: the loser of the database's unique index gets the winner's reference", async () => {
    let raced = false;
    const base = db.client();
    const admin = new Proxy(base, {
      get(target, prop) {
        if (prop !== "from") return (target as any)[prop];
        return (table: string) => {
          const q = (target as any).from(table);
          if (table !== "compliance_requests") return q;
          const insert = q.insert.bind(q);
          q.insert = (row: any) => {
            if (raced) return insert(row);
            raced = true;
            db.seed("compliance_requests", [{ id: "winner", account_id: ACCOUNT, reference: "CMP-2026-000077", type_key: "closure", source: "form", status: "received", customer_email: EMAIL, customer_name: "x" }]);
            return { select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"compliance_requests_form_open_email\"" } }) }) };
          };
          return q;
        };
      },
    });
    expect(await submit({}, env(admin as any))).toEqual({ kind: "ok", reference: "CMP-2026-000077" });
    expect(cases()).toHaveLength(1);
    expect(db.files.size).toBe(0);
  });

  it("needs a session that carries the SAME address: none, expired, another form's, another address, a forged one", async () => {
    expect(await submit({ sessionValue: null })).toEqual({ kind: "session_invalid" });
    expect(await submit({ sessionValue: sessionFor(FORM_CLOSURE, EMAIL, 61 * 60_000) })).toEqual({ kind: "session_invalid" });
    expect(await submit({ sessionValue: sessionFor(FORM_WITHDRAWAL) })).toEqual({ kind: "session_invalid" });
    expect(await submit({ sessionValue: sessionFor(FORM_CLOSURE, "someone.else@example.test") })).toEqual({ kind: "session_invalid" });
    expect(await submit({ sessionValue: "forged.value.here" })).toEqual({ kind: "session_invalid" });
    expect(await submit({ body: closureBody({ email: "someone.else@example.test" }) })).toEqual({ kind: "session_invalid" });
    expect(await submit({ body: closureBody({ email: "" }) })).toEqual({ kind: "session_invalid" });
    expect(cases()).toHaveLength(0);
  });

  it("needs the page's signed token: genuine, for this form, not too old, not too fast", async () => {
    const bad = await submit({ body: closureBody({ token: "x.y.z" }) });
    expect(bad).toMatchObject({ kind: "retry", code: "token_invalid", token: expect.any(String) });
    expect(await submit({ body: closureBody({ token: tokenFor(FORM_WITHDRAWAL) }) })).toMatchObject({ kind: "retry", code: "token_invalid" });
    expect(await submit({ body: closureBody({ token: tokenFor(FORM_CLOSURE, 3 * 60 * 60_000) }) })).toMatchObject({ kind: "retry", code: "token_expired" });
    expect(await submit({ body: closureBody({ token: tokenFor(FORM_CLOSURE, 500) }) })).toMatchObject({ kind: "retry", code: "token_too_fast" });
    // the code was entered a moment ago: also too fast
    expect(await submit({ sessionValue: sessionFor(FORM_CLOSURE, EMAIL, 2000) })).toMatchObject({ kind: "retry", code: "token_too_fast" });
    expect(cases()).toHaveLength(0);
  });

  it("answers a script that filled the hidden field like a success and does nothing", async () => {
    expect(await submit({ body: closureBody({ website: "http://spam.example" }) })).toEqual({ kind: "ok", reference: null });
    expect(cases()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("is limited per address, per form and per email", async () => {
    for (const key of ["cmp:att:ip", "cmp:att:form", "cmp:sub:ip", "cmp:sub:form", "cmp:sub:email"]) {
      denied.clear();
      denied.add(key);
      expect(await submit(), key).toEqual({ kind: "rate_limited" });
    }
    expect(cases()).toHaveLength(0);
  });

  it("is 'not available' when the form is off, the flag is off or the address is unknown, and says nothing more", async () => {
    expect(await submit({ slug: "nothing-here-abc23456" })).toEqual({ kind: "not_found" });
    formRow().enabled = false;
    expect(await submit()).toEqual({ kind: "not_found" });
    formRow().enabled = true;
    (db.rows("account_platform")[0] as any).features = { compliance: false };
    expect(await submit()).toEqual({ kind: "not_found" });
  });

  it("writes only 'created' (source form) and the notice into the trail: no bank detail, no phone, no address", async () => {
    await submit({ body: closureBody({ accountHolder: "Ahmad Yusof" }), files: { letter: { bytes: PDF, name: "l.pdf" } } });
    const events = db.rows("compliance_request_events") as any[];
    // (the 'created' and 'attachment' events are written by the database's triggers, which this in-memory database does not run)
    expect(events.map((e) => e.kind)).toEqual(["notice"]);
    const text = JSON.stringify(events) + JSON.stringify(db.rows("compliance_notices"));
    for (const secret of [ACCOUNT_NUMBER, "Ahmad Yusof", EMAIL, "+60123", "Maybank"]) expect(text).not.toContain(secret);
  });
});

describe("linking to a contact of the same workspace", () => {
  const seedContacts = (rows: Record<string, unknown>[]) => db.seed("contacts", rows);
  const find = (phone = "+601233445566") => matchContact(db.client(), ACCOUNT, EMAIL, phone);

  it("links exactly one match by email, else exactly one by phone", async () => {
    seedContacts([{ id: "c-email", account_id: ACCOUNT, email: "Siti@Example.test", phone_normalized: "60111111111", deleted_at: null }]);
    expect(await find()).toBe("c-email");
    db.tables.contacts = [];
    seedContacts([{ id: "c-phone", account_id: ACCOUNT, email: null, phone_normalized: "601233445566", deleted_at: null }]);
    expect(await find()).toBe("c-phone");
  });

  it("links nothing when two contacts match, when a contact is another workspace's or soft-deleted, or when nothing matches", async () => {
    seedContacts([
      { id: "c1", account_id: ACCOUNT, email: EMAIL, phone_normalized: null, deleted_at: null },
      { id: "c2", account_id: ACCOUNT, email: EMAIL.toUpperCase(), phone_normalized: null, deleted_at: null },
    ]);
    expect(await find()).toBeNull();
    db.tables.contacts = [];
    seedContacts([
      { id: "other-ws", account_id: OTHER_ACCOUNT, email: EMAIL, phone_normalized: "601233445566", deleted_at: null },
      { id: "gone", account_id: ACCOUNT, email: EMAIL, phone_normalized: "601233445566", deleted_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(await find()).toBeNull();
    db.tables.contacts = [];
    expect(await find()).toBeNull();
    seedContacts([
      { id: "p1", account_id: ACCOUNT, email: null, phone_normalized: "601233445566", deleted_at: null },
      { id: "p2", account_id: ACCOUNT, email: null, phone_normalized: "601233445566", deleted_at: null },
    ]);
    expect(await find()).toBeNull();
    expect(await find("12")).toBeNull();
  });

  it("links the case to the contact on submission and never creates a contact", async () => {
    seedContacts([{ id: CONTACT, account_id: ACCOUNT, email: EMAIL, phone_normalized: null, deleted_at: null }]);
    await submit();
    expect(cases()[0].contact_id).toBe(CONTACT);
    expect(db.rows("contacts")).toHaveLength(1);
    db.tables.compliance_requests = [];
    db.tables.contacts = [];
    await submit();
    expect(cases()[0].contact_id).toBeNull();
    expect(db.rows("contacts")).toHaveLength(0);
  });

  it("emails in the parent's language: the form's choice, else the contact's, else English", async () => {
    seedContacts([{ id: CONTACT, account_id: ACCOUNT, email: EMAIL, phone_normalized: null, deleted_at: null, language: "ko-KR" }]);
    await submit({ body: closureBody({ locale: undefined }) });
    expect(cases()[0].customer_locale).toBeNull();
    expect(sent[0].subject).toContain("접수했습니다");
    db.tables.compliance_requests = [];
    db.tables.compliance_notices = [];
    sent.length = 0;
    await submit({ body: closureBody({ locale: "zh" }) });
    expect(cases()[0].customer_locale).toBe("zh");
    expect(sent[0].subject).toContain("已收到");
    db.tables.compliance_requests = [];
    db.tables.compliance_notices = [];
    db.tables.contacts = [];
    sent.length = 0;
    await submit({ body: closureBody({ locale: undefined }) });
    expect(sent[0].subject).toContain("We have received");
  });
});

describe("small things", () => {
  it("cleanEmail is the one place addresses are cleaned", () => {
    expect(cleanEmail(" A@B.CO ")).toBe("a@b.co");
  });
});
