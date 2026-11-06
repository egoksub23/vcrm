import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      description?: string;
      owner_id?: string | null;
      due_date?: string | null;
    } | null;
    if (!body?.description?.trim()) return NextResponse.json({ error: "description required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("incident_actions")
      .insert({
        incident_id: id,
        account_id: ctx.accountId,
        description: body.description.trim(),
        owner_id: body.owner_id ?? null,
        due_date: body.due_date ?? null,
        created_by: ctx.userId,
      })
      .select("*")
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "insert_failed" }, { status: 500 });
    return NextResponse.json({ action: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
