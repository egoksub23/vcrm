// ============================================================
// POST   /api/account/deletion  (owner) — ask for the workspace to be deleted
// DELETE /api/account/deletion  (owner) — cancel the request
//
// POST body: { confirm: "<the workspace name, typed>" }
//
// Asking starts a 30-day wait: the workspace keeps working, shows a notice, and
// can be cancelled at any time until the deletion begins. When the 30 days are
// up the deletion job removes everything (lib/platform/deletion.ts). Export the
// data first (GET /api/account/export). The rules live in the database
// (workspace_deletion_request / _cancel re-check that the caller is the owner).
// ============================================================
import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

function rpcFailure(error: { code?: string; message: string }) {
  if (error.code === "42501") return NextResponse.json({ error: error.message }, { status: 403 });
  if (error.code === "22023") return NextResponse.json({ error: error.message }, { status: 400 });
  console.error("[account deletion] rpc error:", error);
  return NextResponse.json({ error: "Could not update the deletion request" }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("owner");
    const limit = checkRateLimit(`workspace-deletion:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { confirm?: unknown; note?: unknown } | null;
    const { data: account } = await ctx.supabase.from("accounts").select("name").eq("id", ctx.accountId).maybeSingle();
    const name = (account?.name as string | undefined) ?? "";
    // Typing the name is the guard against a mis-click: it must match (ignoring case and edges).
    if (!name || typeof body?.confirm !== "string" || body.confirm.trim().toLowerCase() !== name.trim().toLowerCase()) {
      return NextResponse.json({ error: "Type the workspace name exactly to confirm" }, { status: 400 });
    }
    const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;

    const { data, error } = await ctx.supabase.rpc("workspace_deletion_request", {
      p_account: ctx.accountId,
      p_days: 30,
      p_note: note,
    });
    if (error) return rpcFailure(error);
    return NextResponse.json({ dueAt: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole("owner");
    const limit = checkRateLimit(`workspace-deletion:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { error } = await ctx.supabase.rpc("workspace_deletion_cancel", { p_account: ctx.accountId });
    if (error) return rpcFailure(error);
    return NextResponse.json({ cancelled: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
