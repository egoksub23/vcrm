// ============================================================
// POST   /api/platform/accounts/[id]/deletion — request a workspace's deletion
//   { confirm: "<workspace name>", days?: 0..90, now?: true, note? }
// DELETE /api/platform/accounts/[id]/deletion — cancel a pending request
//
// `days` shortens the owner's 30 days (the operator's call, for example when the
// customer has asked in writing); `now: true` starts the deletion immediately
// (it runs in the background and the hourly job finishes it if it is interrupted).
// A workspace in which a platform operator works cannot be deleted. Typing the
// workspace's name is required, as for the owner.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { runWorkspaceDeletion } from "@/lib/platform/deletion";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rpcFailure(error: { code?: string; message: string }) {
  if (error.code === "42501") return NextResponse.json({ error: error.message }, { status: 403 });
  if (error.code === "22023") return NextResponse.json({ error: error.message }, { status: 400 });
  console.error("[platform deletion] rpc error:", error);
  return NextResponse.json({ error: "Could not update the deletion request" }, { status: 500 });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePlatformAdmin();
    const limit = checkRateLimit(`platform:deletion:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid workspace id" }, { status: 400 });

    const body = (await request.json().catch(() => null)) as
      | { confirm?: unknown; days?: unknown; now?: unknown; note?: unknown }
      | null;
    const db = supabaseAdmin();
    const { data: account } = await db.from("accounts").select("name").eq("id", id).maybeSingle();
    if (!account) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    const name = account.name as string;
    if (typeof body?.confirm !== "string" || body.confirm.trim().toLowerCase() !== name.trim().toLowerCase()) {
      return NextResponse.json({ error: "Type the workspace name exactly to confirm" }, { status: 400 });
    }
    const now = body.now === true;
    const days = now ? 0 : typeof body.days === "number" && Number.isInteger(body.days) ? body.days : 30;
    if (days < 0 || days > 90) return NextResponse.json({ error: "'days' must be from 0 to 90" }, { status: 400 });
    const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;

    // As the operator (the function needs auth.uid() and re-checks the role).
    const { data, error } = await ctx.supabase.rpc("workspace_deletion_request", { p_account: id, p_days: days, p_note: note });
    if (error) return rpcFailure(error);

    if (now) {
      // Fire and forget: the deletion can take minutes, and the hourly job resumes it if this process stops.
      void runWorkspaceDeletion(db, id, { force: true });
    }
    return NextResponse.json({ dueAt: data, started: now });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePlatformAdmin();
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid workspace id" }, { status: 400 });
    const { error } = await ctx.supabase.rpc("workspace_deletion_cancel", { p_account: id });
    if (error) return rpcFailure(error);
    return NextResponse.json({ cancelled: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
