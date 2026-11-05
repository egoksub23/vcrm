import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("broadcast_recipients")
      .select("*, contact:contacts(*)")
      .eq("broadcast_id", id)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ recipients: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
