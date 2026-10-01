// ============================================================
// POST /api/contacts/[id]/restore  (contacts.edit)
//
// Bring a soft-deleted contact back. The database function
// `restore_contact()` (migration 125) re-checks the capability and
// that the contact is actually deleted. A phone number another
// contact has since claimed is a friendly 409, not a 500.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const { id: contactId } = await params;

    const limit = checkRateLimit(`contact-restore:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { error } = await ctx.supabase.rpc("restore_contact", { p_id: contactId });
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          {
            error: "Another contact has since taken that phone number. Update it, then restore this one.",
            code: "phone_conflict",
          },
          { status: 409 },
        );
      }
      if (error.code === "P0002") {
        return NextResponse.json(
          { error: "That contact is not deleted.", code: "not_found" },
          { status: 404 },
        );
      }
      if (error.code === "42501") {
        return NextResponse.json({ error: "You cannot restore this contact." }, { status: 403 });
      }
      console.error("[POST /api/contacts/[id]/restore] rpc error:", error);
      return NextResponse.json({ error: "Failed to restore the contact" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
