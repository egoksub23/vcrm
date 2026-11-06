import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      storage_path?: string;
      url?: string;
      filename?: string;
      mime_type?: string;
      size_bytes?: number;
    } | null;
    if (!body?.storage_path || !body?.url) {
      return NextResponse.json({ error: "storage_path and url required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("ticket_attachments")
      .insert({
        ticket_id: id,
        account_id: ctx.accountId,
        storage_path: body.storage_path,
        url: body.url,
        filename: body.filename ?? "file",
        mime_type: body.mime_type ?? "application/octet-stream",
        size_bytes: body.size_bytes ?? 0,
        uploaded_by: ctx.userId,
      })
      .select("*")
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "insert_failed" }, { status: 500 });
    return NextResponse.json({ attachment: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
