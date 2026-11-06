import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("sign_categories")
      .select("id, key, name, archived, expiry_days, reminder_days, code_required, sign_in_order, position")
      .eq("account_id", ctx.accountId)
      .order("position", { ascending: true })
      .order("name", { ascending: true });
    if (error) {
      console.error("[GET /api/sign/categories] fetch error:", error);
      return NextResponse.json({ error: "Failed to load categories" }, { status: 500 });
    }
    return NextResponse.json({ categories: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const { data, error } = await ctx.supabase
      .from("sign_categories")
      .insert({
        account_id: ctx.accountId,
        name: body.name.trim(),
        key: typeof body.key === "string" ? body.key : undefined,
        position: typeof body.position === "number" ? body.position : 0,
        expiry_days: body.expiry_days ?? null,
        reminder_days: body.reminder_days ?? null,
        code_required: body.code_required ?? false,
        sign_in_order: body.sign_in_order ?? false,
        retention_years: body.retention_years ?? null,
        description: typeof body.description === "string" ? body.description : null,
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message, code: error.code }, { status: 500 });
    return NextResponse.json({ category: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
