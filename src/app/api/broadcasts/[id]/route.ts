import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("broadcasts")
      .select("*")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ broadcast: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      status?: string;
      failed_count?: number;
    } | null;
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.failed_count !== undefined) patch.failed_count = body.failed_count;

    const { error } = await ctx.supabase
      .from("broadcasts")
      .update(patch)
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("broadcasts.send");
    const { id } = await params;
    const { error } = await ctx.supabase
      .from("broadcasts")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
