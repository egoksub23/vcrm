import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      body?: string;
      mentions?: string[];
    } | null;
    if (!body?.body?.trim()) return NextResponse.json({ error: "body required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("incident_comments")
      .insert({
        incident_id: id,
        account_id: ctx.accountId,
        author_id: ctx.userId,
        body: body.body.trim(),
        mentions: body.mentions ?? [],
      })
      .select("*")
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "insert_failed" }, { status: 500 });
    return NextResponse.json({ comment: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
