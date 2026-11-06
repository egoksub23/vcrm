import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string; recipId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { recipId } = await params;
    const body = (await request.json().catch(() => null)) as {
      status?: string;
      sent_at?: string | null;
      whatsapp_message_id?: string | null;
      error_message?: string | null;
    } | null;
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) patch.status = body.status;
    if ("sent_at" in body) patch.sent_at = body.sent_at;
    if ("whatsapp_message_id" in body) patch.whatsapp_message_id = body.whatsapp_message_id;
    if ("error_message" in body) patch.error_message = body.error_message;

    const { error } = await ctx.supabase
      .from("broadcast_recipients")
      .update(patch)
      .eq("id", recipId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
