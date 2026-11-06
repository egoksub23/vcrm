import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("ticket_types")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[GET /api/account/ticket-types] fetch error:", error);
      return NextResponse.json({ error: "Failed to load ticket types" }, { status: 500 });
    }
    return NextResponse.json({ types: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      slug?: string;
      position?: number;
    } | null;
    if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("ticket_types")
      .insert({
        account_id: ctx.accountId,
        name: body.name.trim(),
        slug: body.slug ?? body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) || "type",
        position: body.position ?? 0,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message, code: error.code }, { status: 500 });
    return NextResponse.json({ type: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
