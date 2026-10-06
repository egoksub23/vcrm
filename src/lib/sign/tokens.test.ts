import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  checkCode,
  codeMatches,
  createSession,
  generateCode,
  hashCode,
  hashToken,
  isPlausibleToken,
  sessionCookieName,
  verifySession,
} from "./tokens";

describe("link tokens", () => {
  it("recognises only 64 lower-case hex characters", () => {
    expect(isPlausibleToken("a".repeat(64))).toBe(true);
    expect(isPlausibleToken("A".repeat(64))).toBe(false);
    expect(isPlausibleToken("a".repeat(63))).toBe(false);
    expect(isPlausibleToken("g".repeat(64))).toBe(false);
    expect(isPlausibleToken(null)).toBe(false);
    expect(isPlausibleToken(undefined)).toBe(false);
    expect(isPlausibleToken(`${"a".repeat(63)}\n`)).toBe(false);
  });

  it("hashes with SHA-256, the same way the database does", () => {
    // sha256('abc')
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("verification codes", () => {
  it("are six digits", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it("match only the signer and code they were made for", () => {
    const h = hashCode("123456", "signer-1");
    expect(codeMatches(h, "123456", "signer-1")).toBe(true);
    expect(codeMatches(h, "123457", "signer-1")).toBe(false);
    expect(codeMatches(h, "123456", "signer-2")).toBe(false);
    expect(codeMatches(null, "123456", "signer-1")).toBe(false);
    expect(codeMatches(h, "12345", "signer-1")).toBe(false);
    expect(codeMatches(h, "abcdef", "signer-1")).toBe(false);
  });

  const now = new Date("2026-10-06T08:00:00Z");
  const stored = (over: Partial<{ code_hash: string | null; code_expires_at: string | null; code_attempts: number }> = {}) => ({
    code_hash: hashCode("123456", "s"),
    code_expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    code_attempts: 1,
    ...over,
  });

  it("accepts the right code in time", () => {
    expect(checkCode(stored(), "123456", "s", now)).toEqual({ ok: true });
  });

  it("refuses a wrong code and says how many tries are left", () => {
    expect(checkCode(stored({ code_attempts: 1 }), "000000", "s", now)).toEqual({ ok: false, reason: "wrong", attemptsLeft: CODE_MAX_ATTEMPTS - 1 });
    expect(checkCode(stored({ code_attempts: CODE_MAX_ATTEMPTS }), "000000", "s", now)).toEqual({ ok: false, reason: "too_many_attempts", attemptsLeft: 0 });
  });

  it("refuses even the right code after too many tries, and after the time is up", () => {
    expect(checkCode(stored({ code_attempts: CODE_MAX_ATTEMPTS + 1 }), "123456", "s", now)).toMatchObject({ ok: false, reason: "too_many_attempts" });
    expect(checkCode(stored({ code_expires_at: new Date(now.getTime() - 1).toISOString() }), "123456", "s", now)).toMatchObject({ ok: false, reason: "expired" });
    expect(checkCode(stored({ code_hash: null }), "123456", "s", now)).toMatchObject({ ok: false, reason: "no_code" });
  });
});

describe("signer sessions", () => {
  const saved = { key: process.env.ENCRYPTION_KEY, keys: process.env.ENCRYPTION_KEYS };
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    delete process.env.ENCRYPTION_KEYS;
  });
  afterEach(() => {
    if (saved.key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = saved.key;
    if (saved.keys === undefined) delete process.env.ENCRYPTION_KEYS;
    else process.env.ENCRYPTION_KEYS = saved.keys;
  });

  const t0 = new Date("2026-10-06T08:00:00Z");

  it("proves a signer for a while, and only that signer", () => {
    const s = createSession("signer-1", t0)!;
    expect(verifySession(s.value, "signer-1", new Date(t0.getTime() + 60_000))).toBe(true);
    expect(verifySession(s.value, "signer-2", t0)).toBe(false);
    expect(verifySession(s.value, "signer-1", new Date(t0.getTime() + s.maxAgeSeconds * 1000 + 1000))).toBe(false);
  });

  it("rejects a forged, truncated or changed value", () => {
    const s = createSession("signer-1", t0)!;
    const [id, exp, sig] = s.value.split(".");
    expect(verifySession(`${id}.${Number(exp) + 100000}.${sig}`, "signer-1", t0)).toBe(false);
    expect(verifySession(`${id}.${exp}.${sig.slice(0, -2)}AA`, "signer-1", t0)).toBe(false);
    expect(verifySession(`${id}.${exp}`, "signer-1", t0)).toBe(false);
    expect(verifySession("", "signer-1", t0)).toBe(false);
    expect(verifySession(undefined, "signer-1", t0)).toBe(false);
  });

  it("stops working when the signing key changes", () => {
    const s = createSession("signer-1", t0)!;
    process.env.ENCRYPTION_KEY = "b".repeat(64);
    expect(verifySession(s.value, "signer-1", t0)).toBe(false);
  });

  it("fails closed when the server has no key", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(createSession("signer-1", t0)).toBeNull();
    expect(verifySession("signer-1.99999999999.xx", "signer-1", t0)).toBe(false);
  });

  it("names the cookie per signer so several documents can be open in one browser", () => {
    expect(sessionCookieName("abc")).toBe("sgs-abc");
  });
});
