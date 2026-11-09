import { describe, expect, it, vi } from "vitest";

// A file filed under an incident must carry the school's account id (the column is NOT NULL): without it every upload failed with "Could not save the attachment".
const inserted: Record<string, unknown>[] = [];
let incidentFound = true;

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    userId: "u1",
    accountId: "acc-1",
    supabase: {
      from: (table: string) => {
        if (table === "incidents") return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: incidentFound ? { id: "inc-1" } : null }) }) }) }) };
        return {
          insert: (row: Record<string, unknown>) => {
            inserted.push(row);
            return { select: () => ({ single: async () => ({ data: { id: "att-1", ...row }, error: null }) }) };
          },
        };
      },
    },
  }),
  toErrorResponse: () => new Response("error", { status: 500 }),
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("http://x/api/incidents/inc-1/attachments", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "inc-1" }) });

describe("POST /api/incidents/[id]/attachments", () => {
  it("files the upload under the school's account", async () => {
    incidentFound = true;
    const res = await call({ storage_path: "account-acc-1/incidents/a.jpg", url: "u", filename: "a.jpg", mime_type: "image/jpeg", size_bytes: 10 });
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ incident_id: "inc-1", account_id: "acc-1", uploaded_by: "u1" });
  });

  it("is a 404 for an incident of another school", async () => {
    incidentFound = false;
    const res = await call({ storage_path: "p", url: "u" });
    expect(res.status).toBe(404);
  });
});
