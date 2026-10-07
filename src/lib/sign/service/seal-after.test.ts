import { beforeEach, describe, expect, it, vi } from "vitest";

// The routes hand the sealing to Next's `after`, so the person is not kept waiting for the PDF. Outside a request `after` throws; the work then runs
// at once, and nothing here may ever throw into the route that has already recorded a signature.

const hoisted = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after: (...a: unknown[]) => hoisted.after(...a) }));

import { sealAfterResponse } from "./seal-after";

const ctx = { admin: {} as never, origin: "https://halo.test", deps: {} as never, now: () => new Date("2026-10-07T08:00:00Z") };

beforeEach(() => {
  hoisted.after.mockReset();
});

describe("sealAfterResponse", () => {
  it("schedules the sealing for after the response and does not run it before", async () => {
    const run = vi.fn(async () => undefined);
    let scheduled: (() => Promise<void>) | null = null;
    hoisted.after.mockImplementation((job: () => Promise<void>) => {
      scheduled = job;
    });
    sealAfterResponse(ctx, run);
    expect(run).not.toHaveBeenCalled();
    expect(scheduled).not.toBeNull();
    await scheduled!();
    expect(run).toHaveBeenCalledTimes(1);
    // it seals as the system, with the workspace-free base the job uses
    expect(run).toHaveBeenCalledWith({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now });
  });

  it("runs the sealing at once when there is no request to attach it to", async () => {
    const run = vi.fn(async () => undefined);
    hoisted.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    sealAfterResponse(ctx, run);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never throws, whichever way the sealing fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = vi.fn(async () => {
      throw new Error("the database is away");
    });
    let scheduled: (() => Promise<void>) | null = null;
    hoisted.after.mockImplementation((job: () => Promise<void>) => {
      scheduled = job;
    });
    expect(() => sealAfterResponse(ctx, run)).not.toThrow();
    await expect(scheduled!()).resolves.toBeUndefined();
    expect(errors.mock.calls.some((c) => String(c[1]).includes("the database is away"))).toBe(true);
    errors.mockRestore();
  });
});
