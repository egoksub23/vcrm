// ============================================================
// Sealing right after the answer: a route that has just recorded the LAST signature of a document (or put a stuck one back to be sealed) hands the
// sealing to Next's `after`, which runs once the response has been sent. The person is not kept waiting for the PDF to be built; the signed copy
// is usually there within seconds, and the page they have open asks again by itself. The minute job (jobs.ts) remains the safety net, and the
// claim with a lease (sign_claim_sealing) keeps the two from sealing one document twice.
//
// Outside a request (a unit test, a script) `after` is not available; the work then runs at once, in the background, and never throws.
// ============================================================

import { after } from "next/server";

import type { SignCtx } from "./context";
import { sealSoon } from "./seal";

type Base = Pick<SignCtx, "admin" | "origin" | "deps" | "now">;

/** Seal what is waiting, after the response. `run` stands in for the sealing in tests. */
export function sealAfterResponse(ctx: Base, run: (base: Omit<SignCtx, "accountId" | "userId">) => Promise<unknown> = sealSoon): void {
  const job = async () => {
    try {
      await run({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now });
    } catch (err) {
      console.error("[sign] sealing after the response failed:", err instanceof Error ? err.message : err);
    }
  };
  try {
    after(job);
  } catch {
    void job();
  }
}
