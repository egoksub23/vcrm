// ============================================================
// POST /api/account/audit/restore  { entity_type, entity_id }
//
// Bring a soft-deleted tag / snippet / article back. The capability is
// the one the item's own manage action needs (tags.manage,
// snippets.manage, knowledge.publish); the database function
// `restore_removed_item()` checks it again. Restoring a tag does not
// re-apply it (deleting a tag removes its applications, as it always
// did). A name that was taken in the meantime is a friendly 409.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { UUID_RE } from "@/lib/audit/filters";
import {
  isRestorableEntityType,
  RESTORE_CAPABILITY,
} from "@/lib/audit/types";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      entity_type?: unknown;
      entity_id?: unknown;
    } | null;
    const entityType = body?.entity_type;
    const entityId = body?.entity_id;
    if (!isRestorableEntityType(entityType)) {
      return NextResponse.json(
        { error: "'entity_type' must be tag, snippet or article" },
        { status: 400 },
      );
    }
    if (typeof entityId !== "string" || !UUID_RE.test(entityId)) {
      return NextResponse.json({ error: "'entity_id' must be an id" }, { status: 400 });
    }

    const ctx = await requireCapability(RESTORE_CAPABILITY[entityType]);
    const limit = checkRateLimit(`audit-restore:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { error } = await ctx.supabase.rpc("restore_removed_item", {
      p_entity_type: entityType,
      p_id: entityId,
    });
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          {
            error:
              "Something with that name already exists. Rename or remove it first, then restore this one.",
            code: "name_conflict",
          },
          { status: 409 },
        );
      }
      if (error.code === "P0002") {
        return NextResponse.json(
          { error: "That item is no longer in Recently removed.", code: "not_found" },
          { status: 404 },
        );
      }
      if (error.code === "42501") {
        return NextResponse.json({ error: "You cannot restore this item." }, { status: 403 });
      }
      console.error("[POST /api/account/audit/restore] rpc error:", error);
      return NextResponse.json({ error: "Failed to restore the item" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
