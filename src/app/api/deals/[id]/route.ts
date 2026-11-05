import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

const COLUMNS = "id, title, status, value, currency, contact_id";
const COLUMNS_BOARD = "*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)";

export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const board = new URL(req.url).searchParams.get("board") === "true";
    const { data, error } = await ctx.supabase
      .from("deals")
      .select(board ? COLUMNS_BOARD : COLUMNS)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ deal: data ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const ALLOWED_PATCH = ["title", "status", "value", "currency", "contact_id", "stage_id", "notes"] as const;

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED_PATCH) {
      if (key in body) patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true });
    const { error } = await ctx.supabase
      .from("deals")
      .update(patch)
      .eq("id", id)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { error } = await ctx.supabase
      .from("deals")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
