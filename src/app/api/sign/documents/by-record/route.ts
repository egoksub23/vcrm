import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const COLUMNS = "id, reference, title, status, test, created_at, sent_at, completed_at, cancelled_at";
const KIND_COLUMN: Record<string, string> = {
  contact: "contact_id",
  ticket: "ticket_id",
  deal: "deal_id",
};

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const kind = searchParams.get("kind") ?? "";
    const id = searchParams.get("id") ?? "";
    const col = KIND_COLUMN[kind];
    if (!col || !id) return NextResponse.json({ documents: [] });

    const { data, error } = await ctx.supabase
      .from("sign_documents")
      .select(COLUMNS)
      .eq("account_id", ctx.accountId)
      .eq(col, id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ documents: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
