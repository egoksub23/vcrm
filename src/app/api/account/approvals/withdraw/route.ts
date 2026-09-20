// ============================================================
// POST /api/account/approvals/withdraw  (tags.propose or snippets.propose)
//
//   { entity_type: 'tag' | 'snippet', id }
//
// The proposer takes back a pending proposal, or dismisses a rejected one.
// A creation is soft-deleted (the audit history stays); an edit of a live
// item just clears its pending edit. The withdraw_proposal RPC checks that
// the caller is the proposer.
// ============================================================

import { NextResponse } from "next/server";

import { requireAnyCapability, toErrorResponse } from "@/lib/auth/account";
import { approvalErrorResponse } from "@/lib/approvals/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const ctx = await requireAnyCapability(["tags.propose", "snippets.propose"]);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const type = body.entity_type;
    const id = body.id;
    if ((type !== "tag" && type !== "snippet") || typeof id !== "string" || !UUID.test(id)) {
      return NextResponse.json(
        { error: "'entity_type' (tag or snippet) and 'id' are required" },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase.rpc("withdraw_proposal", {
      p_entity_type: type,
      p_id: id,
    });
    if (error) return approvalErrorResponse(error);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
