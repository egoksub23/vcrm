import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("incident_obligations")
      .select("*")
      .eq("incident_id", id)
      .eq("account_id", ctx.accountId)
      .order("due_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ obligations: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id: incidentId } = await params;
    const body = (await request.json().catch(() => null)) as { oblId?: string; status?: string } | null;
    if (!body?.oblId || !body?.status) {
      return NextResponse.json({ error: "oblId and status required" }, { status: 400 });
    }
    const { data, error } = await ctx.supabase
      .from("incident_obligations")
      .update({ status: body.status })
      .eq("id", body.oblId)
      .eq("incident_id", incidentId)
      .eq("account_id", ctx.accountId)
      .select("*")
      .single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "not found" }, { status: 500 });
    return NextResponse.json({ obligation: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
