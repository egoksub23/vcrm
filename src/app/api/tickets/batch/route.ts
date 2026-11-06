import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const SELECT = "*, contact:contacts(id, name, phone, wa_username, wa_user_id), comments:ticket_comments(count)";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
    const ids = body?.ids ?? [];
    if (ids.length === 0) return NextResponse.json({ tickets: [] });

    const { data, error } = await ctx.supabase
      .from("tickets")
      .select(SELECT)
      .eq("account_id", ctx.accountId)
      .in("id", ids);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ tickets: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
