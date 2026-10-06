import { beforeEach, describe, expect, it, vi } from "vitest";

// An envelope's link serves every document of the person (migration 171): `?doc=<id>` picks the person's own row on that document, and
// anything else answers the same 404 as a link that is not live. The code's session belongs to the link's own row.

const state = vi.hoisted(() => ({ lookup: null as unknown, sessionFor: null as string | null, seen: [] as unknown[] }));

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/sign/feature", () => ({ signEnabled: async () => true }));
vi.mock("@/lib/sign/notify", () => ({ realDeps: {} }));
vi.mock("@/lib/site-url", () => ({ publicOrigin: () => "https://halo.example" }));
vi.mock("@/lib/sign/service/signing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sign/service/signing")>();
  return { ...real, lookupByToken: async () => state.lookup, signerCtx: (_base: unknown, lookup: unknown) => ({ lookup }) };
});
vi.mock("@/lib/sign/tokens", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sign/tokens")>();
  // the cookie is "ok:<signer id>"; it is valid only for the signer it names
  return { ...real, sessionCookieName: (id: string) => `sess_${id}`, verifySession: (value: string | undefined, id: string) => value === `ok:${id}` };
});

import { publicLink } from "./http";

const TOKEN = "a".repeat(64);
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const ANCHOR = { id: "s-anchor", account_id: "acc" };
const SECOND = { id: "s-second", account_id: "acc" };

const envelopeLookup = (code: boolean) => ({
  signer: ANCHOR,
  tokenSigner: ANCHOR,
  doc: { id: D1, code_required: code },
  party: { members: [{ signer: ANCHOR, doc: { id: D1, code_required: code } }, { signer: SECOND, doc: { id: D2, code_required: code } }] },
  secret: {},
});

async function call(url: string, cookie?: string) {
  const request = new Request(url, { headers: cookie ? { cookie } : {} });
  const response = await publicLink(request, Promise.resolve({ token: TOKEN }), async ({ lookup, sessionOk }) => {
    state.seen.push({ signer: (lookup as { signer: { id: string } }).signer.id, doc: (lookup as { doc: { id: string } }).doc.id, sessionOk });
    return new Response(JSON.stringify({ ok: true }), { status: 200 }) as never;
  });
  return response.status;
}

beforeEach(() => {
  state.lookup = envelopeLookup(false);
  state.seen = [];
});

describe("publicLink on an envelope's link", () => {
  it("acts on the link's own document when no document is named", async () => {
    expect(await call(`https://halo.example/api/sign/public/${TOKEN}`)).toBe(200);
    expect(state.seen).toEqual([{ signer: "s-anchor", doc: D1, sessionOk: true }]);
  });

  it("acts on the person's own row on the document that is named", async () => {
    expect(await call(`https://halo.example/api/sign/public/${TOKEN}?doc=${D2}`)).toBe(200);
    expect(state.seen).toEqual([{ signer: "s-second", doc: D2, sessionOk: true }]);
  });

  it("answers 404, and runs nothing, for a document the person is not on, a malformed id and an empty one", async () => {
    for (const doc of ["33333333-3333-4333-8333-333333333333", "not-an-id", "", "../../etc"]) {
      expect(await call(`https://halo.example/api/sign/public/${TOKEN}?doc=${encodeURIComponent(doc)}`)).toBe(404);
    }
    expect(state.seen).toEqual([]);
  });

  it("answers 404 for ?doc= on a link that is not an envelope's", async () => {
    state.lookup = { signer: ANCHOR, tokenSigner: ANCHOR, doc: { id: D1, code_required: false }, party: null, secret: {} };
    expect(await call(`https://halo.example/api/sign/public/${TOKEN}?doc=${D1}`)).toBe(404);
    expect(state.seen).toEqual([]);
  });

  it("keeps the code's session on the link's own row: one code opens every document", async () => {
    state.lookup = envelopeLookup(true);
    // no session yet
    await call(`https://halo.example/api/sign/public/${TOKEN}?doc=${D2}`);
    // the session of the link's own (anchor) row opens the second document too
    await call(`https://halo.example/api/sign/public/${TOKEN}?doc=${D2}`, "sess_s-anchor=ok:s-anchor");
    // a session of the second row is not the link's
    await call(`https://halo.example/api/sign/public/${TOKEN}?doc=${D2}`, "sess_s-second=ok:s-second");
    expect(state.seen.map((s) => (s as { sessionOk: boolean }).sessionOk)).toEqual([false, true, false]);
  });
});
