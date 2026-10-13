import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bankAccountNumber, cleanEmail, cleanLine, cleanText, malaysianPhone, maskEmail, parseAmount } from "./amount";
import { DEFAULT_BANKS, OTHER_BANK, banksFor, chosenBank, parseBankList } from "./banks";
import { holderNameDiffers, nameKey, nameWords, namesMatch } from "./names";
import {
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  SESSION_TTL_MS,
  checkCode,
  codeMatches,
  createSession,
  generateCode,
  hashCode,
  hashEmail,
  hashIp,
  publicFormsConfigured,
  readCookie,
  readSession,
  sessionCookie,
  sessionCookieName,
  sessionHolds,
} from "./session";
import { parsePublicSubmission, yesNoAnswer } from "./validate";

describe("namesMatch: is the bank account holder the same person as the Vircle account holder", () => {
  it("ignores case, spaces, punctuation and accents", () => {
    expect(namesMatch("Siti Aminah", "  SITI   AMINAH ")).toBe(true);
    expect(namesMatch("Siti Aminah", "Siti-Aminah.")).toBe(true);
    expect(namesMatch("José Álvarez", "Jose Alvarez")).toBe(true);
  });

  it("sets aside titles (only at the start), patronymic words and the spellings of Muhammad", () => {
    expect(namesMatch("Siti Aminah binti Yusof", "SITI AMINAH BT YUSOF")).toBe(true);
    expect(namesMatch("Puan Siti Aminah Yusof", "Siti Aminah bt Yusof")).toBe(true);
    expect(namesMatch("Dato' Dr Ahmad bin Ali", "Ahmad Ali")).toBe(true);
    expect(namesMatch("Tan Sri Lim Kok Wing", "Lim Kok Wing")).toBe(true);
    expect(namesMatch("Mohd Faizal a/l Raju", "Muhammad Faizal Raju")).toBe(true);
    expect(namesMatch("Encik Mohamad Hafiz", "Muhammad Hafiz")).toBe(true);
  });

  it("does not take a surname for a title: Tan stays Tan", () => {
    expect(nameWords("Tan Wei Ming")).toEqual(["tan", "wei", "ming"]);
    expect(namesMatch("Tan Wei Ming", "Wei Ming")).toBe(false);
  });

  it("reads the same words in a different order as the same name", () => {
    expect(namesMatch("Tan Wei Ming", "Wei Ming Tan")).toBe(true);
    expect(nameKey("Tan Wei Ming")).toBe(nameKey("Ming Tan Wei"));
  });

  it("treats a different person, an extra word, a missing word and an empty name as different", () => {
    expect(namesMatch("Tan Wei Ming", "Lim Wei Ming")).toBe(false);
    expect(namesMatch("Siti Aminah", "Siti Aminah Zahra")).toBe(false);
    expect(namesMatch("Siti Aminah Zahra", "Siti Aminah")).toBe(false);
    expect(namesMatch("", "")).toBe(false);
    expect(namesMatch("Siti", null)).toBe(false);
    expect(namesMatch("Dr", "Dr")).toBe(true); // a lone title is a name, not nothing
  });

  it("sets aside the Malaysian connectors and honorifics in the way people really type them (migration 186)", () => {
    // son / daughter of: a/l a/p a.l. a.p. a / l s/o d/o, with or without dots, spaces and capitals
    for (const connector of ["a/l", "A/L", "a/p", "A/P", "a.l.", "A.L.", "a.p.", "a / l", "s/o", "S/O", "d/o", "bin", "binti", "bte", "bt", "b.", "bt.", "anak", "al", "ap"]) {
      expect(namesMatch(`Gokula Krishnan ${connector} Subramaniam`, "Gokula Krishnan Subramaniam"), connector).toBe(true);
    }
    // honorifics, one or stacked, only at the start
    for (const title of ["Mr", "Mrs", "Ms", "Mdm", "Dr", "Dr.", "Dato", "Dato'", "Datuk", "Datin", "Tan Sri", "Puan Sri", "Dato Sri", "Datuk Seri", "Haji", "Hajjah", "Hj.", "Encik", "Cik", "Prof"]) {
      expect(namesMatch(`${title} Ahmad Ali`, "Ahmad Ali"), title).toBe(true);
    }
    expect(namesMatch("Dato' Haji Ahmad bin Ali", "AHMAD ALI")).toBe(true);
  });

  it("matches the owner's examples as the same person", () => {
    expect(namesMatch("Gokula Krishnan a/l Subramaniam", "Gokula Krishnan Subramaniam")).toBe(true);
    expect(namesMatch("Siti Aminah binti Ahmad", "AHMAD SITI AMINAH")).toBe(true);
    expect(namesMatch("Dr. Lee Mei Ling", "LEE MEI LING")).toBe(true);
  });

  it("still tells clearly different names apart", () => {
    expect(namesMatch("Gokula Krishnan a/l Subramaniam", "Gokula Krishnan a/l Rajendran")).toBe(false);
    expect(namesMatch("Siti Aminah binti Ahmad", "Siti Aminah binti Yusof")).toBe(false);
    expect(namesMatch("Ahmad Ali", "Ahmad Ali Hassan")).toBe(false);
    expect(namesMatch("Tan Wei Ming", "Lim Wei Ming")).toBe(false);
    expect(namesMatch("Mr Tan", "Mrs Lim")).toBe(false);
  });

  it("does not drop an a, l, s or o that is only a letter of a name", () => {
    expect(nameWords("Ali bin Salleh")).toEqual(["ali", "salleh"]);
    expect(nameWords("Sarah Leong")).toEqual(["sarah", "leong"]);
    expect(nameWords("Ong Soo Ling")).toEqual(["ong", "soo", "ling"]);
  });
});

describe("holderNameDiffers: the staff information flag, never a gate", () => {
  it("is true only for an account the parent called their own whose names differ once normalised", () => {
    expect(holderNameDiffers(true, "Siti Aminah", "Ahmad Yusof")).toBe(true);
    expect(holderNameDiffers(true, "Siti Aminah", "SITI AMINAH")).toBe(false);
    expect(holderNameDiffers(true, "Gokula Krishnan Subramaniam", "Gokula Krishnan a/l Subramaniam")).toBe(false);
    expect(holderNameDiffers(true, "Siti Aminah Yusof", "Siti Aminah Zahra")).toBe(true);
  });

  it("is false for a third-party account (a letter is on file), an unasked question and a missing name", () => {
    expect(holderNameDiffers(false, "Siti Aminah", "Ahmad Yusof")).toBe(false);
    expect(holderNameDiffers(null, "Siti Aminah", "Ahmad Yusof")).toBe(false);
    expect(holderNameDiffers(undefined, "Siti Aminah", "Ahmad Yusof")).toBe(false);
    expect(holderNameDiffers(true, "", "Ahmad Yusof")).toBe(false);
    expect(holderNameDiffers(true, "Siti Aminah", null)).toBe(false);
  });
});

describe("parseAmount", () => {
  it("accepts plain amounts, RM, thousands commas and two decimals", () => {
    expect(parseAmount("80", 1000)).toEqual({ ok: true, value: 80 });
    expect(parseAmount("RM 80.5", 1000)).toEqual({ ok: true, value: 80.5 });
    expect(parseAmount("1,250.50", 5000)).toEqual({ ok: true, value: 1250.5 });
    expect(parseAmount(12.34, 1000)).toEqual({ ok: true, value: 12.34 });
    expect(parseAmount("1000", 1000)).toEqual({ ok: true, value: 1000 });
  });

  it("refuses zero, negative, too many decimals, too large, empty and everything that is not plainly a number", () => {
    expect(parseAmount("0", 1000)).toMatchObject({ ok: false, code: "too_small" });
    expect(parseAmount("-5", 1000)).toMatchObject({ ok: false, code: "invalid" });
    expect(parseAmount("12.345", 1000)).toMatchObject({ ok: false, code: "too_many_decimals" });
    expect(parseAmount("1000.01", 1000)).toMatchObject({ ok: false, code: "too_large" });
    expect(parseAmount("", 1000)).toMatchObject({ ok: false, code: "required" });
    expect(parseAmount(undefined, 1000)).toMatchObject({ ok: false, code: "required" });
    for (const v of ["1e3", "abc", "1.234,50", "1,25", "12,34,567", "NaN", "Infinity", "0x10", "1 000.00 0", ".5"]) expect(parseAmount(v, 1_000_000), v).toMatchObject({ ok: false });
  });
});

describe("malaysianPhone, bankAccountNumber, cleanEmail, cleanLine, cleanText, maskEmail", () => {
  it("normalises a Malaysian number to +60 and refuses others", () => {
    expect(malaysianPhone("+6012334455667")).toBe("+6012334455667");
    expect(malaysianPhone("012-3344 5566")).toBe("+601233445566");
    expect(malaysianPhone("60123344556")).toBe("+60123344556");
    expect(malaysianPhone("+65 8123 4567")).toBeNull();
    expect(malaysianPhone("012")).toBeNull();
    expect(malaysianPhone("call me")).toBeNull();
    expect(malaysianPhone(null)).toBeNull();
    expect(malaysianPhone("+60 0123344556")).toBeNull();
  });

  it("keeps a bank account number as digits only, 6 to 20 of them", () => {
    expect(bankAccountNumber("8800 1234-5678 9012")).toBe("8800123456789012");
    expect(bankAccountNumber("12345")).toBeNull();
    expect(bankAccountNumber("1".repeat(21))).toBeNull();
    expect(bankAccountNumber("12345a678")).toBeNull();
    expect(bankAccountNumber(123456789)).toBeNull();
  });

  it("cleans an email and refuses what is not one", () => {
    expect(cleanEmail("  Siti@Example.TEST ")).toBe("siti@example.test");
    for (const v of ["nope", "a@b", "a b@c.d", "a@b.c,d@e.f", `${"x".repeat(250)}@e.fr`, "<x>@y.zz", null, 5]) expect(cleanEmail(v as never), String(v)).toBeNull();
  });

  it("cleans lines and texts", () => {
    expect(cleanLine("  Siti \n Aminah\t", 50)).toBe("Siti Aminah");
    expect(cleanLine("", 50)).toBeNull();
    expect(cleanLine("x".repeat(51), 50)).toBeNull();
    expect(cleanText("a\r\nb\u0000c", 50)).toBe("a\nb c");
    expect(cleanText("   ", 50)).toBeNull();
  });

  it("masks an email without showing it", () => {
    expect(maskEmail("siti@example.test")).toBe("s•••@example.test");
    expect(maskEmail("a@b.co")).toBe("a••@b.co");
    expect(maskEmail("nonsense")).toBe("•••");
  });
});

describe("banks", () => {
  it("offers the default list unless the form has its own", () => {
    expect(banksFor(null)).toBe(DEFAULT_BANKS);
    expect(banksFor([])).toBe(DEFAULT_BANKS);
    expect(banksFor(["Own Bank"])).toEqual(["Own Bank"]);
    expect(DEFAULT_BANKS).toContain("Maybank");
  });

  it("takes a bank from the list, or the typed name of Other bank, and nothing else", () => {
    expect(chosenBank("Maybank", "", DEFAULT_BANKS)).toBe("Maybank");
    expect(chosenBank("Not a bank", "", DEFAULT_BANKS)).toBeNull();
    expect(chosenBank(OTHER_BANK, "  Bank   of Elsewhere ", DEFAULT_BANKS)).toBe("Bank of Elsewhere");
    expect(chosenBank(OTHER_BANK, "", DEFAULT_BANKS)).toBeNull();
    expect(chosenBank(OTHER_BANK, "x".repeat(81), DEFAULT_BANKS)).toBeNull();
    expect(chosenBank(undefined, "Maybank", DEFAULT_BANKS)).toBeNull();
  });

  it("parses an administrator's list: one per line, de-duplicated, trimmed", () => {
    expect(parseBankList("Maybank\r\n  CIMB Bank \n\nmaybank\nPublic  Bank")).toEqual(["Maybank", "CIMB Bank", "Public Bank"]);
    expect(parseBankList("  \n ")).toBeNull();
    expect(parseBankList(Array.from({ length: 120 }, (_, i) => `Bank ${i}`).join("\n"))).toHaveLength(80);
  });
});

describe("the code, the hashes and the session", () => {
  const FORM = "11111111-1111-4111-8111-111111111111";
  const OTHER_FORM = "22222222-2222-4222-8222-222222222222";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = saved;
  });

  it("generates six digits", () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it("hashes the address and the caller with a key, lower-cased, and never in the clear", () => {
    expect(publicFormsConfigured()).toBe(true);
    const h = hashEmail("Siti@Example.test");
    expect(h).toBe(hashEmail("siti@example.test"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("siti");
    expect(hashIp("203.0.113.9")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp("unknown")).toBeNull();
    expect(hashEmail("other@example.test")).not.toBe(h);
  });

  it("a code means something only for its own form and address", () => {
    const eh = hashEmail("siti@example.test")!;
    const stored = hashCode("123456", FORM, eh)!;
    expect(codeMatches(stored, "123456", FORM, eh)).toBe(true);
    expect(codeMatches(stored, "123457", FORM, eh)).toBe(false);
    expect(codeMatches(stored, "123456", OTHER_FORM, eh)).toBe(false);
    expect(codeMatches(stored, "123456", FORM, hashEmail("x@example.test")!)).toBe(false);
    expect(codeMatches(stored, "12345", FORM, eh)).toBe(false);
    expect(codeMatches(null, "123456", FORM, eh)).toBe(false);
  });

  it("checks an entry: right, wrong with tries left, expired, used, too many tries, no code", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    const eh = hashEmail("siti@example.test")!;
    const row = (over: Partial<{ attempts: number; expires_at: string; consumed_at: string | null }> = {}) => ({
      code_hash: hashCode("654321", FORM, eh)!,
      expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      attempts: 1,
      consumed_at: null,
      ...over,
    });
    expect(checkCode(row(), "654321", FORM, eh, now)).toEqual({ ok: true });
    expect(checkCode(row(), "000000", FORM, eh, now)).toEqual({ ok: false, reason: "wrong", attemptsLeft: CODE_MAX_ATTEMPTS - 1 });
    expect(checkCode(row({ attempts: CODE_MAX_ATTEMPTS }), "000000", FORM, eh, now)).toEqual({ ok: false, reason: "too_many_attempts", attemptsLeft: 0 });
    expect(checkCode(row({ attempts: CODE_MAX_ATTEMPTS + 1 }), "654321", FORM, eh, now)).toMatchObject({ ok: false, reason: "too_many_attempts" });
    expect(checkCode(row({ expires_at: new Date(now.getTime() - 1).toISOString() }), "654321", FORM, eh, now)).toMatchObject({ ok: false, reason: "expired" });
    expect(checkCode(row({ consumed_at: now.toISOString() }), "654321", FORM, eh, now)).toMatchObject({ ok: false, reason: "no_code" });
    expect(checkCode(null, "654321", FORM, eh, now)).toMatchObject({ ok: false, reason: "no_code" });
  });

  it("a session carries the hash of the verified address for one form for an hour", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    const eh = hashEmail("siti@example.test")!;
    const s = createSession(FORM, eh, now)!;
    expect(s.maxAgeSeconds).toBe(SESSION_TTL_MS / 1000);
    expect(s.value).not.toContain("siti");
    const read = readSession(s.value, FORM, new Date(now.getTime() + 59 * 60_000));
    expect(read).toMatchObject({ ok: true, issuedAtMs: now.getTime() });
    expect(sessionHolds(read, "Siti@example.test")).toBe(true);
    expect(sessionHolds(read, "someone.else@example.test")).toBe(false);
    expect(readSession(s.value, FORM, new Date(now.getTime() + 61 * 60_000))).toEqual({ ok: false });
    expect(readSession(s.value, OTHER_FORM, now)).toEqual({ ok: false });
    expect(readSession(s.value.replace(/.$/, (c) => (c === "A" ? "B" : "A")), FORM, now)).toEqual({ ok: false });
    expect(readSession(`${FORM}.${"0".repeat(40)}.1.99999999999.xx`, FORM, now)).toEqual({ ok: false });
    expect(readSession(null, FORM, now)).toEqual({ ok: false });
    expect(readSession("a.b.c", FORM, now)).toEqual({ ok: false });
  });

  it("builds an HttpOnly cookie and reads one back", () => {
    const name = sessionCookieName("close-account-abc23456");
    expect(name).toBe("cmp-s-close-account-abc23456");
    const c = sessionCookie(name, "a.b c", 3600);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=3600");
    expect(readCookie(`x=1; ${name}=${encodeURIComponent("a.b c")}; y=2`, name)).toBe("a.b c");
    expect(readCookie("x=1", name)).toBeNull();
    expect(readCookie(null, name)).toBeNull();
  });

  it("without a key nothing can be signed", () => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEYS;
    expect(publicFormsConfigured()).toBe(false);
    expect(createSession(FORM, "x".repeat(64))).toBeNull();
    expect(hashEmail("a@b.co")).toBeNull();
    expect(hashCode("123456", FORM, "x")).toBeNull();
  });
});

describe("parsePublicSubmission", () => {
  const rules = { maxAmount: 5000, banks: DEFAULT_BANKS };
  const closure = {
    wantClose: "yes",
    name: "Siti Aminah binti Yusof",
    phone: "012-334 4556",
    childrenFinished: true,
    allowancesStopped: true,
    reason: "Moving abroad",
    bankOwn: "yes",
    bankChoice: "Maybank",
    accountNumber: "8800 1234 5678",
    accountHolder: "SITI AMINAH BT YUSOF",
    declaration: true,
  };
  const withdrawal = { name: "Siti Aminah", phone: "+60123344556", amount: "RM 120.50", reasonKind: "over_topup", transactionRefs: "TX1\nTX2", bankOwn: "yes", bankChoice: OTHER_BANK, bankOther: "Bank of Elsewhere", accountNumber: "123456789", accountHolder: "Siti Aminah", declaration: true };

  it("accepts a complete closure and maps it to the type's fields", () => {
    const r = parsePublicSubmission("closure", closure, rules);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok || "declined" in r) throw new Error("expected a value");
    expect(r.value).toMatchObject({ type: "closure", name: "Siti Aminah binti Yusof", phone: "+60123344556", bankOwn: true, needsLetter: false });
    expect(r.value.answers).toEqual({
      confirm_closure: true,
      children_finished_school: true,
      allowances_cancelled: true,
      reason: "Moving abroad",
      bank_account_is_own: true,
      bank_name: "Maybank",
      bank_account_number: "880012345678",
      bank_account_holder: "SITI AMINAH BT YUSOF",
      declaration: true,
    });
  });

  it("answers 'No, I do not want to close' with nothing to create", () => {
    expect(parsePublicSubmission("closure", { ...closure, wantClose: "no" }, rules)).toEqual({ ok: true, declined: true });
    expect(parsePublicSubmission("closure", { wantClose: "no" }, rules)).toEqual({ ok: true, declined: true });
  });

  it("REFUSES a closure without the school and allowance acknowledgements, or without the declaration", () => {
    for (const missing of ["childrenFinished", "allowancesStopped", "declaration"] as const) {
      for (const value of [false, undefined, "false", "", 0]) {
        const r = parsePublicSubmission("closure", { ...closure, [missing]: value }, rules);
        expect(r.ok && !("declined" in r), `${missing}=${String(value)}`).toBe(false);
        if (!r.ok) expect(r.problems[missing]).toBe("must_acknowledge");
      }
    }
    expect(parsePublicSubmission("closure", { ...closure, wantClose: undefined }, rules)).toMatchObject({ ok: false, problems: { wantClose: "required" } });
  });

  it("asks for an authorization letter exactly when the parent says the bank account is NOT theirs, whatever the names are", () => {
    for (const type of ["closure", "withdrawal"] as const) {
      const body = type === "closure" ? closure : withdrawal;
      const own = parsePublicSubmission(type, body, rules);
      const notOwn = parsePublicSubmission(type, { ...body, bankOwn: "no" }, rules);
      if (!own.ok || "declined" in own || !notOwn.ok || "declined" in notOwn) throw new Error("expected values");
      expect(own.value).toMatchObject({ bankOwn: true, needsLetter: false });
      expect(notOwn.value).toMatchObject({ bankOwn: false, needsLetter: true });
      expect(own.value.answers.bank_account_is_own).toBe(true);
      expect(notOwn.value.answers.bank_account_is_own).toBe(false);
    }
  });

  it("no longer asks for a letter, or refuses anything, because the typed names differ", () => {
    const other = parsePublicSubmission("closure", { ...closure, accountHolder: "Ahmad Yusof" }, rules);
    if (!other.ok || "declined" in other) throw new Error("expected a value");
    expect(other.value.needsLetter).toBe(false);
    // the letter is wanted for 'No' even when the names are the very same
    const same = parsePublicSubmission("closure", { ...closure, bankOwn: "no", accountHolder: "Siti Aminah binti Yusof" }, rules);
    if (!same.ok || "declined" in same) throw new Error("expected a value");
    expect(same.value.needsLetter).toBe(true);
  });

  it("REQUIRES the answer: nothing chosen, blank or something else is refused, with no default", () => {
    for (const type of ["closure", "withdrawal"] as const) {
      const body = type === "closure" ? closure : withdrawal;
      for (const value of [undefined, "", null, "maybe", 3]) {
        const r = parsePublicSubmission(type, { ...body, bankOwn: value }, rules);
        expect(r.ok, `${type} ${String(value)}`).toBe(false);
        if (!r.ok) expect(r.problems.bankOwn, `${type} ${String(value)}`).toBe(value === "maybe" ? "not_a_choice" : "required");
      }
      const none = { ...body } as Record<string, unknown>;
      delete none.bankOwn;
      expect(parsePublicSubmission(type, none, rules)).toMatchObject({ ok: false, problems: { bankOwn: "required" } });
    }
    expect(yesNoAnswer("yes")).toBe(true);
    expect(yesNoAnswer("no")).toBe(false);
    expect(yesNoAnswer(true)).toBe(true);
    expect(yesNoAnswer("false")).toBe(false);
    expect(yesNoAnswer("")).toBeNull();
  });

  it("keeps the holder name required in both cases", () => {
    for (const bankOwn of ["yes", "no"]) {
      expect(parsePublicSubmission("closure", { ...closure, bankOwn, accountHolder: "" }, rules)).toMatchObject({ ok: false, problems: { accountHolder: "required" } });
    }
  });

  it("names every field that is wrong", () => {
    const r = parsePublicSubmission("closure", { wantClose: "yes", name: "", phone: "12", bankChoice: "Fake Bank", accountNumber: "12", accountHolder: "", declaration: false }, rules);
    expect(r).toMatchObject({
      ok: false,
      problems: { name: "required", phone: "invalid", childrenFinished: "must_acknowledge", allowancesStopped: "must_acknowledge", bankChoice: "not_a_choice", accountNumber: "invalid", accountHolder: "required", declaration: "must_acknowledge" },
    });
  });

  it("accepts a withdrawal: amount, reason words, references, a bank typed by hand", () => {
    const r = parsePublicSubmission("withdrawal", withdrawal, rules);
    if (!r.ok || "declined" in r) throw new Error("expected a value");
    expect(r.value.answers).toMatchObject({ amount: 120.5, reason_kind: "over_topup", reason: "Over top-up", transaction_refs: "TX1\nTX2", bank_name: "Bank of Elsewhere", bank_account_number: "123456789", bank_account_holder: "Siti Aminah", declaration: true });
    expect(r.value.needsLetter).toBe(false);
  });

  it("refuses a withdrawal amount that is zero, over the maximum or malformed, and 'other' with no words", () => {
    expect(parsePublicSubmission("withdrawal", { ...withdrawal, amount: "0" }, rules)).toMatchObject({ ok: false, problems: { amount: "too_small" } });
    expect(parsePublicSubmission("withdrawal", { ...withdrawal, amount: "5000.01" }, rules)).toMatchObject({ ok: false, problems: { amount: "too_large" } });
    expect(parsePublicSubmission("withdrawal", { ...withdrawal, amount: "1e3" }, rules)).toMatchObject({ ok: false, problems: { amount: "invalid" } });
    expect(parsePublicSubmission("withdrawal", { ...withdrawal, reasonKind: "other" }, rules)).toMatchObject({ ok: false, problems: { reasonText: "required" } });
    expect(parsePublicSubmission("withdrawal", { ...withdrawal, reasonKind: "because" }, rules)).toMatchObject({ ok: false, problems: { reasonKind: "not_a_choice" } });
    const other = parsePublicSubmission("withdrawal", { ...withdrawal, reasonKind: "other", reasonText: "Paid twice" }, rules);
    if (!other.ok || "declined" in other) throw new Error("expected a value");
    expect(other.value.answers.reason).toBe("Other: Paid twice");
  });

  it("ignores a body that is not an object", () => {
    expect(parsePublicSubmission("closure", null, rules)).toMatchObject({ ok: false });
    expect(parsePublicSubmission("closure", [1, 2], rules)).toMatchObject({ ok: false });
  });
});
