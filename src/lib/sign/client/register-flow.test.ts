import { describe, expect, it } from "vitest";

import { DEFAULT_ASKED, type AskedFields } from "@/lib/sign/registration/types";

import { EMPTY_VALUES, FINAL_NOTICES, firstProblem, precheck, readAnswer, type Values } from "./register-flow";

const good: Values = { fullName: "Ali bin Ahmad", company: "Kedai Runcit Ali", email: "ali@kedai.example", phone: "+60 12-345 6789", consent: true };

describe("what can be said before anything is sent", () => {
  it("lets a complete form through", () => {
    expect(precheck(good, DEFAULT_ASKED)).toEqual({});
    expect(precheck({ ...good, phone: "" }, DEFAULT_ASKED)).toEqual({});
  });

  it("names every empty required detail at once, in the order the page shows them", () => {
    const found = precheck(EMPTY_VALUES, DEFAULT_ASKED);
    expect(found).toEqual({ full_name: "required", company: "required", email: "required", consent: "required" });
    expect(firstProblem(found)).toBe("full_name");
    expect(firstProblem({ consent: "required", email: "invalid" })).toBe("email");
    expect(firstProblem({})).toBeNull();
  });

  it("catches a plainly wrong email, phone, markup and length", () => {
    expect(precheck({ ...good, email: "no at sign" }, DEFAULT_ASKED)).toEqual({ email: "invalid" });
    expect(precheck({ ...good, email: "a@b" }, DEFAULT_ASKED)).toEqual({ email: "invalid" });
    expect(precheck({ ...good, phone: "012-345 6789" }, DEFAULT_ASKED)).toEqual({ phone: "invalid" });
    expect(precheck({ ...good, phone: "12345" }, DEFAULT_ASKED)).toEqual({ phone: "invalid" });
    expect(precheck({ ...good, fullName: "<b>Ali</b>" }, DEFAULT_ASKED)).toEqual({ full_name: "invalid" });
    expect(precheck({ ...good, fullName: "x".repeat(121) }, DEFAULT_ASKED)).toEqual({ full_name: "too_long" });
    expect(precheck({ ...good, company: "x".repeat(161) }, DEFAULT_ASKED)).toEqual({ company: "too_long" });
    expect(precheck({ ...good, email: `${"a".repeat(250)}@b.example` }, DEFAULT_ASKED)).toEqual({ email: "too_long" });
    expect(precheck({ ...good, consent: false }, DEFAULT_ASKED)).toEqual({ consent: "required" });
  });

  it("does not ask about what the form does not ask", () => {
    const asked: AskedFields = { full_name: "off", email: "required", phone: "off", company: "optional" };
    expect(precheck({ ...EMPTY_VALUES, email: "a@b.example", consent: true, phone: "garbage", fullName: "<x>" }, asked)).toEqual({});
    expect(precheck({ ...EMPTY_VALUES, email: "a@b.example", consent: true }, { ...DEFAULT_ASKED, full_name: "off", company: "off", phone: "required" })).toEqual({ phone: "required" });
  });

  it("counts spaces and lines as nothing", () => {
    expect(precheck({ ...good, fullName: "   \n\t " }, DEFAULT_ASKED)).toEqual({ full_name: "required" });
  });
});

describe("what the route's answer means", () => {
  it("is taken on a success", () => {
    expect(readAnswer(200, { ok: true })).toEqual({ kind: "ok" });
    expect(readAnswer(200, {})).toEqual({ kind: "notice", code: "generic" });
  });

  it("carries which details are wrong and ignores anything it does not know", () => {
    expect(readAnswer(400, { code: "invalid", problems: { email: "invalid", consent: "required", fax: "required", phone: "weird" } })).toEqual({ kind: "problems", problems: { email: "invalid", consent: "required" } });
    expect(readAnswer(400, { code: "invalid", problems: {} })).toEqual({ kind: "notice", code: "generic" });
    expect(readAnswer(400, { code: "invalid" })).toEqual({ kind: "notice", code: "generic" });
  });

  it("carries a fresh token to try again with", () => {
    expect(readAnswer(400, { code: "token_expired", token: "fresh" })).toEqual({ kind: "retry", code: "token_expired", token: "fresh" });
    expect(readAnswer(400, { code: "captcha_failed" })).toEqual({ kind: "retry", code: "captcha_failed", token: null });
    for (const code of ["token_invalid", "token_too_fast"]) expect(readAnswer(400, { code, token: "t" })).toMatchObject({ kind: "retry", code });
  });

  it("words each way a visit can end, and which of them end it", () => {
    for (const [status, code] of [[429, "rate_limited"], [429, "form_cap"], [503, "send_failed"], [503, "try_later"], [503, "unavailable"], [404, "not_found"]] as const) {
      expect(readAnswer(status, { code })).toEqual({ kind: "notice", code });
    }
    expect([...FINAL_NOTICES].sort()).toEqual(["form_cap", "not_found", "send_failed", "unavailable"]);
    // a failure to save is a final answer: the details are with the workspace; "try later" is not
    expect(FINAL_NOTICES).toContain("send_failed");
    expect(FINAL_NOTICES).not.toContain("try_later");
    expect(FINAL_NOTICES).not.toContain("rate_limited");
  });

  it("says something sensible for an answer it does not know", () => {
    expect(readAnswer(429, null)).toEqual({ kind: "notice", code: "rate_limited" });
    expect(readAnswer(500, "<html>")).toEqual({ kind: "notice", code: "generic" });
    expect(readAnswer(418, { code: "teapot" })).toEqual({ kind: "notice", code: "generic" });
    expect(readAnswer(0, undefined)).toEqual({ kind: "notice", code: "generic" });
  });
});
