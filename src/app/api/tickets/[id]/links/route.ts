import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      from_ticket_id?: string;
      to_ticket_id?: string;
      link_type?: string;
    } | null;
    if (!body?.from_ticket_id || !body?.to_ticket_id) {
      return NextResponse.json({ error: "from_ticket_id and to_ticket_id required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("ticket_links")
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        from_ticket_id: body.from_ticket_id,
        to_ticket_id: body.to_ticket_id,
        link_type: body.link_type ?? "related",
      })
      .select("*")
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "23505" ? 409 : 500 },
      );
    }
    return NextResponse.json({ link: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
