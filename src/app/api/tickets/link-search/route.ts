import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const excludeId = url.searchParams.get("exclude") ?? "";

    const cleaned = query.replace(/[,()%*\\]/g, " ").trim();
    if (!cleaned) return NextResponse.json({ tickets: [] });

    const keyed = /^(?:[a-z][a-z0-9]{1,5}-|#)?(\d+)$/i.exec(cleaned);
    const filter = keyed
      ? `ticket_number.eq.${Number(keyed[1])},subject.ilike.%${cleaned}%`
      : `subject.ilike.%${cleaned}%`;

    let q = ctx.supabase
      .from("tickets")
      .select("id, ticket_number, subject, status, category")
      .eq("account_id", ctx.accountId)
      .or(filter)
      .order("updated_at", { ascending: false })
      .limit(8);

    if (excludeId) q = q.neq("id", excludeId);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ tickets: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
