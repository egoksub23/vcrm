import { beforeEach, describe, expect, it, vi } from "vitest";

// The server side of /s/[token] does what the API does for a signer (src/lib/sign/http.ts `publicLink` and
// GET /api/sign/public/[token]). This holds it to that: a link that is not live says only "invalid", the
// rate limit and the code session are honoured, and "viewed" is recorded only when the person can see the
// document.

const state = vi.hoisted(() => ({
  rate: true,
  lookup: null as unknown,
  enabled: true,
  cookie: undefined as string | undefined,
  sessionValid: false,
  pageState: "active",
  viewed: vi.fn(),
  built: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "TestPhone/1.0" }),
  cookies: async () => ({ get: () => (state.cookie === undefined ? undefined : { value: state.cookie }) }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ success: state.rate }) }));
vi.mock("@/lib/sign/feature", () => ({ signEnabled: async () => state.enabled }));
vi.mock("@/lib/sign/notify", () => ({ realDeps: {} }));
vi.mock("@/lib/site-url", () => ({ publicOrigin: () => "https://halo.example" }));
vi.mock("@/lib/sign/service/signing", () => ({
  lookupByToken: async () => state.lookup,
  signerCtx: (_base: unknown, lookup: unknown) => ({ lookup }),
  codeRequiredFor: (l: { doc: { code_required: boolean } }) => l.doc.code_required,
  pickDocument: () => null,
  pageState: () => state.pageState,
  markViewed: state.viewed,
  buildView: async (_ctx: unknown, _lookup: unknown, sessionOk: boolean) => {
    state.built(sessionOk);
    return { state: state.pageState, needsCode: false };
  },
}));
vi.mock("@/lib/sign/tokens", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sign/tokens")>();
  return { ...real, verifySession: () => state.sessionValid };
});

import { loadSigning } from "./load";

// React's cache keeps one answer per token, as it does per request in the app, so each test uses its own token
let counter = 0;
const fresh = () => (counter++).toString(16).padStart(64, "0");
const lookup = (codeRequired: boolean) => ({ signer: { id: "s1", account_id: "a1" }, tokenSigner: { id: "s1" }, party: null, doc: { code_required: codeRequired }, secret: {} });

beforeEach(() => {
  state.rate = true;
  state.lookup = lookup(false);
  state.enabled = true;
  state.cookie = undefined;
  state.sessionValid = false;
  state.pageState = "active";
  state.viewed.mockClear();
  state.built.mockClear();
});

describe("loadSigning", () => {
  it("is invalid for a token that cannot be one, without touching the database", async () => {
    expect(await loadSigning("short")).toEqual({ kind: "invalid" });
    expect(state.built).not.toHaveBeenCalled();
  });

  it("is invalid for a link that is not live, and for a workspace with Secure Sign off, alike", async () => {
    state.lookup = null;
    expect(await loadSigning(fresh())).toEqual({ kind: "invalid" });
    state.lookup = lookup(false);
    state.enabled = false;
    expect(await loadSigning(fresh())).toEqual({ kind: "invalid" });
  });

  it("is busy when the caller has made too many requests", async () => {
    state.rate = false;
    expect(await loadSigning(fresh())).toEqual({ kind: "busy" });
  });

  it("gives the view and records that the link was opened", async () => {
    const result = await loadSigning(fresh());
    expect(result).toMatchObject({ kind: "ok", sessionOk: true });
    expect(state.viewed).toHaveBeenCalledTimes(1);
    expect(state.viewed.mock.calls[0][2]).toBe("203.0.113.9");
    expect(state.viewed.mock.calls[0][3]).toBe("TestPhone/1.0");
  });

  it("does not record a view, and says the session is not there, while a code is still needed", async () => {
    state.lookup = lookup(true);
    state.cookie = undefined;
    const result = await loadSigning(fresh());
    expect(result).toMatchObject({ kind: "ok", sessionOk: false });
    expect(state.viewed).not.toHaveBeenCalled();
    expect(state.built).toHaveBeenCalledWith(false);
  });

  it("accepts a valid code session", async () => {
    state.lookup = lookup(true);
    state.cookie = "signed-session";
    state.sessionValid = true;
    const result = await loadSigning(fresh());
    expect(result).toMatchObject({ kind: "ok", sessionOk: true });
    expect(state.viewed).toHaveBeenCalledTimes(1);
  });

  it("does not record a view for a document that is not open", async () => {
    state.pageState = "completed";
    await loadSigning(fresh());
    expect(state.viewed).not.toHaveBeenCalled();
  });
});
