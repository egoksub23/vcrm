// GET /api/tags — all account tags
// ?for_contacts=true  — only tags usable on contacts (approved)
// ?approved_only=true — all approved tags regardless of for_contacts flag
import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const forContacts = searchParams.get("for_contacts") === "true";
    const approvedOnly = searchParams.get("approved_only") === "true";
    let query = ctx.supabase.from("tags").select("*").eq("account_id", ctx.accountId);
    if (forContacts) {
      query = query.eq("for_contacts", true).eq("approval_status", "approved");
    } else if (approvedOnly) {
      query = query.eq("approval_status", "approved");
    }
    query = query.order("name");
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ tags: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
