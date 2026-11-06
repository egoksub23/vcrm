import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { LIST_PAGE_SIZE, BOARD_COLUMN_PAGE_SIZE } from "@/lib/tickets/constants";

const SELECT = "*, contact:contacts(id, name, phone, wa_username, wa_user_id), comments:ticket_comments(count)";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "list";
    const status = url.searchParams.get("status");
    const from = parseInt(url.searchParams.get("from") ?? "0", 10);
    const countOnly = url.searchParams.get("count") === "1";

    if (countOnly && status) {
      const { count, error } = await ctx.supabase
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("account_id", ctx.accountId)
        .eq("status", status);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ count: count ?? 0 });
    }

    if (mode === "board" && status) {
      const { data, count, error } = await ctx.supabase
        .from("tickets")
        .select(SELECT, { count: "exact" })
        .eq("account_id", ctx.accountId)
        .eq("status", status)
        .order("board_rank", { ascending: false })
        .order("created_at", { ascending: false })
        .range(from, from + BOARD_COLUMN_PAGE_SIZE - 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ tickets: data ?? [], total: count ?? 0 });
    }

    // list mode
    const { data, error } = await ctx.supabase
      .from("tickets")
      .select(SELECT)
      .eq("account_id", ctx.accountId)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + LIST_PAGE_SIZE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ tickets: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
