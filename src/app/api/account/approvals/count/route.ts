// ============================================================
// GET /api/account/approvals/count  (approvals.review)
//
// How many proposals wait for a decision: the badge on Settings and on the
// Approvals section. approvals_pending_count() is 0 for anyone without
// approvals.review, so the number can never leak.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { approvalErrorResponse } from "@/lib/approvals/server";

export async function GET() {
  try {
    const ctx = await requireCapability("approvals.review");
    const { data, error } = await ctx.supabase.rpc("approvals_pending_count");
    if (error) return approvalErrorResponse(error);
    return NextResponse.json({ count: typeof data === "number" ? data : 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
