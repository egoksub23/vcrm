// The signer's Finish routes seal right after the answer: when the last signature was just recorded (a document is now sealing), the sealing is handed
// to `after`; when it was not, nothing is scheduled. (The sealing itself, and the minute job that backs it up, are tested in service/seal-*.test.ts.)

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  scheduled: vi.fn(),
  complete: vi.fn(),
  finish: vi.fn(),
  ctx: { admin: {}, accountId: "a", userId: null, origin: "https://halo.test", deps: {}, now: () => new Date() },
  body: {} as Record<string, unknown>,
}));

vi.mock("@/lib/sign/http", () => ({
  json: (body: unknown, status = 200) => Response.json(body, { status }),
  readJson: async () => h.body,
  publicLink: async (_req: Request, _params: unknown, handler: (c: unknown) => Promise<Response>) => handler({ ctx: h.ctx, lookup: { party: {}, doc: {}, signer: {} }, sessionOk: true, ip: "203.0.113.9", device: "Chrome" }),
}));
vi.mock("@/lib/sign/service/seal-after", () => ({ sealAfterResponse: (...a: unknown[]) => h.scheduled(...a) }));
vi.mock("@/lib/sign/service/signing", () => ({ completeSigning: (...a: unknown[]) => h.complete(...a), codeRequiredFor: () => false }));
vi.mock("@/lib/sign/service/envelope-signing", () => ({ finishEnvelope: (...a: unknown[]) => h.finish(...a) }));

import { POST as complete } from "./complete/route";
import { POST as finish } from "./envelope/finish/route";

const params = { params: Promise.resolve({ token: "t".repeat(40) }) };
const post = () => new Request("https://halo.test/x", { method: "POST" });

beforeEach(() => {
  h.scheduled.mockReset();
  h.complete.mockReset();
  h.finish.mockReset();
  h.body = {};
});

describe("POST /api/sign/public/[token]/complete", () => {
  it("hands the sealing to `after` when the last signature was just recorded, with the workspace context", async () => {
    h.complete.mockResolvedValue({ sealing: true, invited: [] });
    const res = await complete(post(), params);
    expect(await res.json()).toEqual({ completed: true, sealing: true });
    expect(h.scheduled).toHaveBeenCalledTimes(1);
    expect(h.scheduled.mock.calls[0][0]).toBe(h.ctx);
  });

  it("schedules nothing when others still have to sign, or when the call only checked", async () => {
    h.complete.mockResolvedValue({ sealing: false, invited: [] });
    await complete(post(), params);
    h.body = { check: true };
    h.complete.mockResolvedValue({ sealing: false, invited: [], checked: true });
    expect(await (await complete(post(), params)).json()).toEqual({ checked: true });
    expect(h.scheduled).not.toHaveBeenCalled();
  });
});

describe("POST /api/sign/public/[token]/envelope/finish", () => {
  it("hands the sealing to `after` when a document of the collection has every signature now", async () => {
    h.finish.mockResolvedValue({ completed: ["d1"], remaining: [], sealing: true });
    const res = await finish(post(), params);
    expect(await res.json()).toEqual({ completed: ["d1"], remaining: [], sealing: true });
    expect(h.scheduled).toHaveBeenCalledTimes(1);
  });

  it("schedules nothing when no document is ready to be sealed", async () => {
    h.finish.mockResolvedValue({ completed: ["d1"], remaining: [], sealing: false });
    await finish(post(), params);
    expect(h.scheduled).not.toHaveBeenCalled();
  });
});
