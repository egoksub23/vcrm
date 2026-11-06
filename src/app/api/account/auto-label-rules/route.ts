import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const [rulesRes, accountRes, aiRes] = await Promise.all([
      ctx.supabase
        .from("auto_label_rules")
        .select("id, tag_id, keywords, match_type, description, is_active")
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: true }),
      ctx.supabase
        .from("accounts")
        .select("auto_label_ai_enabled")
        .eq("id", ctx.accountId)
        .maybeSingle(),
      ctx.supabase
        .from("ai_configs")
        .select("is_active")
        .eq("account_id", ctx.accountId)
        .maybeSingle(),
    ]);
    if (rulesRes.error) {
      return NextResponse.json({ error: rulesRes.error.message }, { status: 500 });
    }
    return NextResponse.json({
      rules: rulesRes.data ?? [],
      aiEnabled: Boolean((accountRes.data as { auto_label_ai_enabled?: boolean } | null)?.auto_label_ai_enabled),
      aiConfigured: Boolean((aiRes.data as { is_active?: boolean } | null)?.is_active),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      tag_id?: string;
      keywords?: string[];
      match_type?: string;
      description?: string | null;
      is_active?: boolean;
    } | null;
    if (!body?.tag_id) return NextResponse.json({ error: "tag_id required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("auto_label_rules")
      .insert({
        account_id: ctx.accountId,
        tag_id: body.tag_id,
        keywords: body.keywords ?? [],
        match_type: body.match_type ?? "word",
        description: body.description ?? null,
        is_active: body.is_active ?? true,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ rule: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
