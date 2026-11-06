import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      creates?: unknown[];
      updates?: { id: string; patch: Record<string, unknown> }[];
    } | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    let failed = 0;

    const creates = Array.isArray(body.creates) ? body.creates : [];
    if (creates.length > 0) {
      const rows = creates.map((row) => ({ ...(row as Record<string, unknown>), account_id: ctx.accountId, user_id: ctx.userId }));
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await ctx.supabase.from("tags").insert(rows.slice(i, i + CHUNK));
        if (error) failed += Math.min(CHUNK, rows.length - i);
      }
    }

    const updates = Array.isArray(body.updates) ? body.updates : [];
    for (const u of updates) {
      if (!u.id || !u.patch) continue;
      const { error } = await ctx.supabase.from("tags").update(u.patch).eq("id", u.id).eq("account_id", ctx.accountId);
      if (error) failed++;
    }

    return NextResponse.json({ ok: true, failed });
  } catch (err) {
    return toErrorResponse(err);
  }
}
