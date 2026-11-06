// GET /api/custom-fields — all custom field definitions for the account
import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("custom_fields")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("field_name");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ custom_fields: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
