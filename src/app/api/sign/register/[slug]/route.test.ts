import { beforeEach, describe, expect, it, vi } from "vitest";

// The edge of the public registration route: how each outcome of the service becomes a response, and what the route
// refuses before the service is asked. The service itself is proved in lib/sign/service/registration.test.ts.

const submitRegistration = vi.fn();
vi.mock("@/lib/sign/service/registration", () => ({ submitRegistration: (...args: unknown[]) => submitRegistration(...args) }));
vi.mock("@/lib/sign/service/registration-env", () => ({ registrationEnv: () => ({ marker: "env" }) }));

import { __resetRateLimitForTests } from "@/lib/rate-limit";

import { POST } from "./route";

const call = (body: unknown, headers: Record<string, string> = {}, slug = "merchant-sign-up-7k2m9x4q") =>
  POST(new Request(`https://halo.test/api/sign/register/${slug}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", "user-agent": "UA/1", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ slug }),
  });

beforeEach(() => {
  // (a block, so the mock is not handed back to the runner as a teardown to call)
  submitRegistration.mockReset();
  __resetRateLimitForTests();
});

describe("POST /api/sign/register/[slug]", () => {
  it("passes the slug, the body, the caller's address and browser to the service", async () => {
    submitRegistration.mockResolvedValue({ kind: "ok" });
    await call({ email: "a@b.example" });
    expect(submitRegistration).toHaveBeenCalledWith({ marker: "env" }, { slug: "merchant-sign-up-7k2m9x4q", body: { email: "a@b.example" }, ip: "203.0.113.9", userAgent: "UA/1" });
  });

  it("answers a success with nothing but ok, never cached", async () => {
    submitRegistration.mockResolvedValue({ kind: "ok" });
    const res = await call({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("says which details are wrong", async () => {
    submitRegistration.mockResolvedValue({ kind: "invalid", problems: { email: "invalid", consent: "required" } });
    const res = await call({});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid", problems: { email: "invalid", consent: "required" } });
  });

  it("hands back a fresh token to try again with", async () => {
    for (const code of ["token_invalid", "token_expired", "token_too_fast", "captcha_failed"]) {
      submitRegistration.mockResolvedValue({ kind: "retry", code, token: "fresh.token" });
      const res = await call({});
      expect(res.status, code).toBe(400);
      expect(await res.json(), code).toMatchObject({ code, token: "fresh.token" });
    }
  });

  it("answers an unknown, switched-off or Secure Sign-off page with one 404 that says nothing else", async () => {
    submitRegistration.mockResolvedValue({ kind: "not_found" });
    const a = await call({}, {}, "merchant-sign-up-7k2m9x4q");
    const b = await call({}, {}, "nothing-here-aaaaaaaa");
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
  });

  it("tells a connection that tried too much and a full day apart, both 429", async () => {
    submitRegistration.mockResolvedValue({ kind: "rate_limited" });
    const limited = await call({});
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    submitRegistration.mockResolvedValue({ kind: "cap" });
    const full = await call({});
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ code: "form_cap" });
  });

  it("says whether the details were saved when it could not finish, and never a link", async () => {
    submitRegistration.mockResolvedValue({ kind: "failed", saved: true });
    const kept = await call({});
    expect(kept.status).toBe(503);
    const keptBody = await kept.json();
    expect(keptBody.code).toBe("send_failed");
    submitRegistration.mockResolvedValue({ kind: "failed", saved: false });
    const lost = await call({});
    expect(lost.status).toBe(503);
    const lostBody = await lost.json();
    expect(lostBody.code).toBe("try_later");
    for (const b of [keptBody, lostBody]) expect(JSON.stringify(b)).not.toMatch(/https?:|\/s\//);
  });

  it("says the page is not available when the server cannot sign its token", async () => {
    submitRegistration.mockResolvedValue({ kind: "not_configured" });
    const res = await call({});
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "unavailable" });
  });

  it("refuses a body that is not JSON, or too large, before the service is asked", async () => {
    const bad = await call("{not json");
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("bad_json");
    const big = await call({ x: "y".repeat(30_000) });
    expect(big.status).toBe(413);
    expect(submitRegistration).not.toHaveBeenCalled();
  });

  it("turns an address away before the service is asked when it posts far too often", async () => {
    submitRegistration.mockResolvedValue({ kind: "ok" });
    const statuses: number[] = [];
    for (let i = 0; i < 95; i++) statuses.push((await call({}, { "x-forwarded-for": "198.51.100.7" })).status);
    expect(statuses.slice(0, 90).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(90)).toEqual([429, 429, 429, 429, 429]);
    expect(submitRegistration).toHaveBeenCalledTimes(90);
    // another address is not held up by it
    expect((await call({}, { "x-forwarded-for": "198.51.100.8" })).status).toBe(200);
  });

  it("does not reveal what went wrong inside when the service breaks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    submitRegistration.mockImplementation(async () => {
      throw new Error("connection to postgres://secret@db failed");
    });
    const res = await call({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/postgres|secret/);
  });
});
