import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      recipient_party?: string;
      reference?: string | null;
    } | null;
    if (!body?.recipient_party) return NextResponse.json({ error: "recipient_party required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("incident_notifications_sent")
      .insert({
        incident_id: id,
        account_id: ctx.accountId,
        recipient_party: body.recipient_party,
        reference: body.reference?.trim() || null,
        sent_at: new Date().toISOString(),
        recorded_by: ctx.userId,
      })
      .select("*")
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "insert_failed" }, { status: 500 });
    return NextResponse.json({ notification: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
