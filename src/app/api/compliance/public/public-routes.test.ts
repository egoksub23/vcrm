/* eslint-disable @typescript-eslint/no-explicit-any -- rows and bodies are read loosely in a test */
// The three public routes of the parent form, end to end through the real service on the in-memory database: ask for a code, enter it (a cookie comes
// back), submit (multipart, with the letter). What the routes themselves refuse before the service is asked (bodies, types, the early ceiling) and the
// headers every answer carries.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceMailDeps } from "@/lib/email/workspace-mail";
import type { PublicEnv } from "@/lib/compliance/public/service";
import { issueFormToken } from "@/lib/sign/registration/token";
import type { FakeDb } from "@/lib/sign/service/fake-db";

import { ACCOUNT_NUMBER, FORM_CLOSURE, SLUG_CLOSURE, publicWorld } from "@/lib/compliance/test-support";

let db: FakeDb;
let sent: { to: string; subject: string; text: string }[];
let nowMs: number;

vi.mock("@/lib/compliance/public/http", async (original) => {
  const real = await original<typeof import("@/lib/compliance/public/http")>();
  const env = (): PublicEnv => {
    const mail: WorkspaceMailDeps = {
      emailConfigured: () => true,
      sendEmail: async (m: any) => {
        sent.push({ to: m.to, subject: m.subject, text: m.text });
      },
      loadIdentity: async () => ({ fromName: "Vircle", replyTo: null }),
    };
    return { admin: db.client(), now: () => new Date(nowMs), limit: async () => true, captcha: { enabled: false, verify: async () => true }, notices: { mail, now: () => new Date(nowMs) } };
  };
  return { ...real, publicEnv: env };
});

import { __resetRateLimitForTests } from "@/lib/rate-limit";

import { POST as codePost } from "./[slug]/code/route";
import { POST as submitPost } from "./[slug]/submit/route";
import { POST as verifyPost } from "./[slug]/verify/route";

const EMAIL = "siti@example.test";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const askCode = (email = EMAIL, slug = SLUG_CLOSURE) => codePost(json(`https://halo.test/api/compliance/public/${slug}/code`, { email }), ctx(slug));
const enter = (code: string, email = EMAIL, slug = SLUG_CLOSURE) => verifyPost(json(`https://halo.test/api/compliance/public/${slug}/verify`, { email, code }), ctx(slug));
const lastCode = () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)![1];
const cookieOf = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0];

function payload(over: Record<string, unknown> = {}) {
  return {
    token: issueFormToken(FORM_CLOSURE, new Date(nowMs - 60_000)),
    email: EMAIL,
    locale: "en",
    wantClose: "yes",
    name: "Siti Aminah",
    phone: "012-334 4556",
    childrenFinished: true,
    allowancesStopped: true,
    bankChoice: "Maybank",
    accountNumber: ACCOUNT_NUMBER,
    accountHolder: "Siti Aminah",
    declaration: true,
    website: "",
    ...over,
  };
}
function multipart(over: Record<string, unknown> = {}, files: Record<string, Uint8Array> = {}) {
  const f = new FormData();
  f.set("payload", JSON.stringify(payload(over)));
  for (const [k, v] of Object.entries(files)) f.set(k, new File([v as BlobPart], `${k}.pdf`, { type: "application/pdf" }));
  return f;
}
const submit = (form: FormData | string, cookie: string, slug = SLUG_CLOSURE, headers: Record<string, string> = {}) =>
  submitPost(new Request(`https://halo.test/api/compliance/public/${slug}/submit`, { method: "POST", headers: { cookie, "x-forwarded-for": "203.0.113.9", ...headers }, body: form }), ctx(slug));

/** A confirmed address: the cookie the verify route sets. The session must be a little older than eight seconds for a submission to be believed. */
async function confirmed(): Promise<string> {
  await askCode();
  const res = await enter(lastCode());
  expect(res.status).toBe(200);
  const cookie = cookieOf(res);
  nowMs += 20_000;
  return cookie;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = publicWorld();
  sent = [];
  nowMs = Date.now();
  __resetRateLimitForTests();
});

describe("the whole way through the routes", () => {
  it("asks for a code, enters it, and submits: a case with a reference, the confirmation emailed, every answer no-store", async () => {
    const asked = await askCode();
    expect(asked.status).toBe(200);
    expect(asked.headers.get("cache-control")).toBe("no-store");
    expect(await asked.json()).toEqual({ ok: true, emailMasked: "s•••@example.test" });

    const verified = await enter(lastCode());
    expect(verified.status).toBe(200);
    expect(verified.headers.get("cache-control")).toBe("no-store");
    const setCookie = verified.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`cmp-s-${SLUG_CLOSURE}=`);
    expect(setCookie).not.toContain("siti");
    expect(JSON.stringify(await verified.json())).not.toContain(lastCode());

    nowMs += 20_000;
    const res = await submit(multipart(), cookieOf(verified));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ ok: true, reference: expect.stringMatching(/^CMP-\d{4}-\d{6}$/) });
    expect(db.rows("compliance_requests")).toHaveLength(1);
    expect(sent.map((m) => m.subject)).toEqual([expect.stringContaining("Your confirmation code"), expect.stringContaining(body.reference)]);
  });

  it("takes the authorization letter in the same post and keeps it in the private bucket", async () => {
    const cookie = await confirmed();
    const res = await submit(multipart({ accountHolder: "Ahmad Yusof" }, { letter: PDF }), cookie);
    expect(res.status).toBe(200);
    expect(db.rows("compliance_request_files")).toHaveLength(1);
    expect(db.files.size).toBe(1);
  });

  it("asks for the letter when the names differ and says which control (a code, never a stored value)", async () => {
    const cookie = await confirmed();
    const res = await submit(multipart({ accountHolder: "Ahmad Yusof" }), cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "invalid", problems: { letter: "file_required" } });
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("refuses a closure without the acknowledgements, server-side", async () => {
    const cookie = await confirmed();
    const res = await submit(multipart({ childrenFinished: false, allowancesStopped: false }), cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid", problems: { childrenFinished: "must_acknowledge", allowancesStopped: "must_acknowledge" } });
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("answers a repeat exactly like a first request", async () => {
    const cookie = await confirmed();
    const a = await (await submit(multipart(), cookie)).json();
    const b = await (await submit(multipart(), cookie)).json();
    expect(b).toEqual(a);
    expect(db.rows("compliance_requests")).toHaveLength(1);
  });
});

describe("the code routes", () => {
  it("answers a wrong code with the tries left, an unknown or used code with no_code, and an expired one with expired", async () => {
    await askCode();
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    const w = await enter(wrong);
    expect(w.status).toBe(400);
    expect(await w.json()).toEqual({ code: "wrong_code", attemptsLeft: 4 });
    expect(w.headers.get("set-cookie")).toBeNull();
    nowMs += 16 * 60_000;
    const e = await enter(lastCode());
    expect(await e.json()).toEqual({ code: "expired" });
    const stranger = await enter("123456", "nobody@example.test");
    expect(await stranger.json()).toEqual({ code: "no_code" });
  });

  it("is limited: three codes an hour per address is the service's; the route's early ceiling answers 429 in the app's shape", async () => {
    for (let i = 0; i < 90; i++) await codePost(json("https://halo.test/x", { email: `x${i}@example.test` }, { "x-forwarded-for": "198.51.100.7" }), ctx("nothing-here-abc23456"));
    const res = await codePost(json("https://halo.test/x", { email: EMAIL }, { "x-forwarded-for": "198.51.100.7" }), ctx(SLUG_CLOSURE));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ code: "rate_limited" });
  });

  it("rejects a body that is not a small JSON object", async () => {
    const big = await codePost(json("https://halo.test/x", { email: EMAIL, pad: "x".repeat(9000) }), ctx(SLUG_CLOSURE));
    expect(big.status).toBe(400);
    const notJson = await codePost(json("https://halo.test/x", "{not json"), ctx(SLUG_CLOSURE));
    expect(notJson.status).toBe(400);
    const array = await verifyPost(json("https://halo.test/x", "[1,2]"), ctx(SLUG_CLOSURE));
    expect(array.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("the submission route", () => {
  it("needs the session and the same address", async () => {
    const none = await submit(multipart(), "");
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ code: "session_invalid" });
    const cookie = await confirmed();
    const other = await submit(multipart({ email: "someone.else@example.test" }), cookie);
    expect(other.status).toBe(401);
    // the cookie of this form is no use on another address of the same site
    const wrongName = await submit(multipart(), cookie.replace(`cmp-s-${SLUG_CLOSURE}`, "cmp-s-other-form-abc23456"));
    expect(wrongName.status).toBe(401);
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("answers a script that filled the hidden field like a success, and does nothing", async () => {
    const cookie = await confirmed();
    const res = await submit(multipart({ website: "http://spam.example" }), cookie);
    expect(await res.json()).toEqual({ ok: true, reference: null });
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("hands back a fresh token when the page's is no good", async () => {
    const cookie = await confirmed();
    const res = await submit(multipart({ token: "not.a.token.at.all" }), cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "token_invalid", token: expect.stringMatching(/\./) });
  });

  it("says 'No request was made' as a plain success with nothing created", async () => {
    const cookie = await confirmed();
    const res = await submit(multipart({ wantClose: "no" }), cookie);
    expect(await res.json()).toEqual({ ok: true, declined: true });
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("answers an unknown, switched-off or Compliance-off form with one 404 for all three routes", async () => {
    const unknown = "nothing-here-abc23456";
    const a = [await askCode(EMAIL, unknown), await enter("123456", EMAIL, unknown), await submit(multipart(), "", unknown)];
    (db.rows("compliance_public_forms")[0] as any).enabled = false;
    const b = [await askCode(), await enter("123456"), await submit(multipart(), "")];
    (db.rows("compliance_public_forms")[0] as any).enabled = true;
    (db.rows("account_platform")[0] as any).features = { compliance: false };
    const c = [await askCode(), await enter("123456"), await submit(multipart(), "")];
    for (const r of [...a, ...b, ...c]) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ code: "not_found" });
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses what is not a multipart post, a payload that is not JSON, and a body over the cap", async () => {
    const cookie = await confirmed();
    const notMultipart = await submit(JSON.stringify(payload()), cookie, SLUG_CLOSURE, { "content-type": "application/json" });
    expect(notMultipart.status).toBe(400);
    const f = new FormData();
    f.set("payload", "{not json");
    expect((await submit(f, cookie)).status).toBe(400);
    // a body that says it is over the cap is refused before a byte of it is read (the cap on a body that lies is readBodyCapped's, tested with it)
    const res = await submit(multipart(), cookie, SLUG_CLOSURE, { "content-length": String(30 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: "too_large" });
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("refuses a file that is not a PDF or an image, whatever its name says", async () => {
    const cookie = await confirmed();
    const f = multipart({ accountHolder: "Ahmad Yusof" });
    f.set("letter", new File([new TextEncoder().encode("<html>x</html>")], "letter.pdf", { type: "application/pdf" }));
    const res = await submit(f, cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "invalid", problems: { letter: "file_type" } });
    expect(db.files.size).toBe(0);
  });

  it("never puts the bank details, the phone number or the stored answers in any answer", async () => {
    const cookie = await confirmed();
    const res = await submit(multipart(), cookie);
    const text = JSON.stringify(await res.json());
    for (const bad of [ACCOUNT_NUMBER, "Maybank", "+6012", "012-334", "siti@example.test"]) expect(text).not.toContain(bad);
  });
});
