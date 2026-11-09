import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a file: it must be this school's, and the answer must be honest when row-level security refuses (a refused delete is not an error from the database).
let found = true;
let selects = 0;
let stillThere = false;
const removed: string[][] = [];

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    userId: "u1",
    accountId: "acc-1",
    supabase: {
      from: () => {
        return {
          select: () => {
            selects += 1;
            const first = selects === 1;
            const chain: Record<string, unknown> = {};
            chain.eq = () => chain;
            chain.maybeSingle = async () => ({ data: first ? (found ? { id: "att-1", storage_path: "account-acc-1/incidents/a.jpg" } : null) : stillThere ? { id: "att-1" } : null });
            return chain;
          },
          delete: () => {
            const chain: Record<string, unknown> = {};
            chain.eq = () => chain;
            (chain as { then: (f: (v: unknown) => unknown) => unknown }).then = (f) => f({ error: null });
            return chain;
          },
        };
      },
    },
  }),
  toErrorResponse: () => new Response("error", { status: 500 }),
}));
vi.mock("@/lib/storage/provider", () => ({ appStorage: () => ({ from: () => ({ remove: async (p: string[]) => { removed.push(p); return { data: null, error: null }; } }) }) }));

import { DELETE } from "./route";

const call = () => DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: "inc-1", attId: "att-1" }) });

beforeEach(() => {
  found = true;
  stillThere = false;
  removed.length = 0;
  selects = 0;
});

describe("DELETE /api/incidents/[id]/attachments/[attId]", () => {
  it("removes the row and the stored file", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(removed).toEqual([["account-acc-1/incidents/a.jpg"]]);
  });
  it("is a 404 for a file that is not this school's", async () => {
    found = false;
    expect((await call()).status).toBe(404);
    expect(removed).toEqual([]);
  });
  it("says so (403) when security kept the row, and keeps the stored file", async () => {
    stillThere = true;
    expect((await call()).status).toBe(403);
    expect(removed).toEqual([]);
  });
});
