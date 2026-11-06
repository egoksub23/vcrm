import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      position?: number;
    } | null;
    if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("ticket_resolutions")
      .insert({
        account_id: ctx.accountId,
        name: body.name.trim(),
        position: body.position ?? 0,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message, code: error.code }, { status: 500 });
    return NextResponse.json({ resolution: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const [listRes, accountRes] = await Promise.all([
      ctx.supabase
        .from("ticket_resolutions")
        .select("*")
        .eq("account_id", ctx.accountId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      ctx.supabase
        .from("accounts")
        .select("require_ticket_resolution")
        .eq("id", ctx.accountId)
        .maybeSingle(),
    ]);
    if (listRes.error) {
      console.error("[GET /api/account/ticket-resolutions] fetch error:", listRes.error);
      return NextResponse.json({ error: "Failed to load ticket resolutions" }, { status: 500 });
    }
    const required =
      (accountRes.data as { require_ticket_resolution?: boolean } | null)
        ?.require_ticket_resolution ?? true;
    return NextResponse.json({ resolutions: listRes.data ?? [], required });
  } catch (err) {
    return toErrorResponse(err);
  }
}
