import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { status?: string } | null;
    const p_status = body?.status ?? "online";

    const { error } = await ctx.supabase.rpc("touch_presence", { p_status });
    if (error) {
      console.error("[POST /api/presence] touch_presence failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
