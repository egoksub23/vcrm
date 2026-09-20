// ============================================================
// POST /api/account/members/[userId]/remove   (members.remove)
//
// Safely remove a member. In ONE transaction (remove_account_member,
// migration 083) the database:
//   - deletes their team memberships,
//   - unassigns their open conversations and open / in-progress /
//     pending tickets, or hands them to `reassignTo` when given,
//   - moves the person to a fresh personal account (their login stays).
//
// Body: { reassignTo?: string | null }
// Response: { ok, removed, unassignedConversations, unassignedTickets,
//             reassignedConversations, reassignedTickets, reassignedTo }
//
// The confirm dialog shows the counts BEFORE this call, from the
// members list (open_conversations / open_tickets).
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { removeMemberResponse } from "@/lib/teams/member-rpc";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireCapability("members.remove");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    const body = (await request.json().catch(() => null)) as
      | { reassignTo?: unknown }
      | null;

    const raw = body?.reassignTo;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return NextResponse.json(
        { error: "'reassignTo' must be a member id" },
        { status: 400 },
      );
    }

    return await removeMemberResponse(ctx, userId, raw || null);
  } catch (err) {
    return toErrorResponse(err);
  }
}
