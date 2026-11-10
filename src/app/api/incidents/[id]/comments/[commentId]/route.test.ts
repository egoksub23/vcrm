import { beforeEach, describe, expect, it, vi } from "vitest";

// Editing a note (a finding, say): the words are changed through the server, who changed them is recorded, and a note that is not the school's is a 404.
let found: { id: string; body: string } | null = { id: "c1", body: "Old words" };
const updates: Record<string, unknown>[] = [];

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async () => ({
    userId: "u1",
    accountId: "acc-1",
    supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: found }) }) }) }) }) }) },
  }),
  toErrorResponse: () => new Response("error", { status: 500 }),
}));
vi.mock("@/lib/postgres/db", () => ({
  createAdminPgDb: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: "c1", ...patch, edited_at: "2026-11-10T01:00:00Z" }, error: null }) }) }) }) }) };
      },
    }),
  }),
}));

import { PATCH } from "./route";

const call = (body: unknown) =>
  PATCH(new Request("http://x/api/incidents/i1/comments/c1", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "i1", commentId: "c1" }) });

describe("PATCH /api/incidents/[id]/comments/[commentId]", () => {
  beforeEach(() => {
    found = { id: "c1", body: "Old words" };
    updates.length = 0;
  });

  it("changes the words and records who changed them", async () => {
    const res = await call({ body: "  Better words  " });
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ body: "Better words", edited_by: "u1" }]);
  });

  it("still marks and unmarks a finding without touching the words", async () => {
    const res = await call({ is_finding: true });
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ is_finding: true, kind: "finding" }]);
  });

  it("sets the kind of a note, and clears it with null", async () => {
    expect((await call({ kind: "closing" })).status).toBe(200);
    expect((await call({ kind: "investigation" })).status).toBe(200);
    expect((await call({ kind: null })).status).toBe(200);
    expect(updates).toEqual([
      { kind: "closing", is_finding: false },
      { kind: "investigation", is_finding: false },
      { kind: null, is_finding: false },
    ]);
    expect((await call({ kind: "gossip" })).status).toBe(400);
  });

  it("does not count saving the same words again as an edit", async () => {
    const res = await call({ body: "Old words" });
    expect(res.status).toBe(200);
    expect(updates).toEqual([]);
  });

  it("refuses an empty note, a note that is too long, and an empty request", async () => {
    expect((await call({ body: "   " })).status).toBe(400);
    expect((await call({ body: "x".repeat(10001) })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect((await call({ is_finding: "yes" })).status).toBe(400);
  });

  it("is a 404 for a note that is not on this school's incident", async () => {
    found = null;
    expect((await call({ body: "x" })).status).toBe(404);
  });
});
