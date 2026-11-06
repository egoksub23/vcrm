import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);

    // Count documents past their retention date (for settings display)
    const pastRetention = searchParams.get("pastRetention") === "true";
    if (pastRetention) {
      const { count, error } = await ctx.supabase
        .from("sign_documents")
        .select("id", { count: "exact", head: true })
        .eq("account_id", ctx.accountId)
        .eq("status", "completed")
        .lt("retain_until", new Date().toISOString());
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ count: count ?? 0 });
    }

    // Count documents by template_version_ids (for form-builder used-check)
    const idsParam = searchParams.get("templateVersionIds");
    if (idsParam) {
      const ids = idsParam.split(",").filter(Boolean);
      if (ids.length === 0) return NextResponse.json({ count: 0 });
      const { count, error } = await ctx.supabase
        .from("sign_documents")
        .select("id", { count: "exact", head: true })
        .eq("account_id", ctx.accountId)
        .in("template_version_id", ids);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ count: count ?? 0 });
    }

    return NextResponse.json({ count: 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
