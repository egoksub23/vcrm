// ============================================================
// Server helpers shared by the member routes: mapping the SQLSTATEs the
// member RPCs raise onto HTTP statuses, and the safe-removal call.
//
// Error contract of the RPCs (migrations 018, 079, 083):
//   42501 insufficient_privilege  -> 403
//   22023 invalid_parameter_value -> 400
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import type { CapabilityContext } from "@/lib/auth/account";
import { isUuid } from "@/lib/teams/team-ids";

export function rpcErrorToResponse(
  err: PostgrestError,
  fallback = "Failed to update member",
): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[members route] unexpected RPC error:", err);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

/** What `remove_account_member` reports back. */
export interface RemovalResult {
  removed: boolean;
  unassigned_conversations: number;
  unassigned_tickets: number;
  reassigned_conversations: number;
  reassigned_tickets: number;
  reassigned_to: string | null;
}

/**
 * Remove a member through the RPC: it clears their team rows and either
 * unassigns or reassigns (to `reassignTo`) their open conversations and
 * tickets, all in one transaction. Authorisation (members.remove, target
 * strictly below the caller, never the Owner or yourself) is enforced by
 * the RPC; the caller of this helper has already passed
 * requireCapability("members.remove").
 */
export async function removeMemberResponse(
  ctx: CapabilityContext,
  userId: string,
  reassignTo: string | null,
): Promise<NextResponse> {
  if (reassignTo !== null && !isUuid(reassignTo)) {
    return NextResponse.json(
      { error: "'reassignTo' must be a member id" },
      { status: 400 },
    );
  }

  const { data, error } = await ctx.supabase.rpc("remove_account_member", {
    p_user_id: userId,
    p_reassign_to: reassignTo,
  });

  if (error) return rpcErrorToResponse(error, "Failed to remove member");

  const result = (data ?? {}) as Partial<RemovalResult>;
  return NextResponse.json({
    ok: true,
    removed: result.removed === true,
    unassignedConversations: result.unassigned_conversations ?? 0,
    unassignedTickets: result.unassigned_tickets ?? 0,
    reassignedConversations: result.reassigned_conversations ?? 0,
    reassignedTickets: result.reassigned_tickets ?? 0,
    reassignedTo: result.reassigned_to ?? null,
  });
}
