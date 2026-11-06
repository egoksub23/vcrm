import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string; actionId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { actionId } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("incident_actions")
      .update(body)
      .eq("id", actionId)
      .eq("account_id", ctx.accountId)
      .select("*")
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "update_failed" }, { status: 500 });
    return NextResponse.json({ action: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
