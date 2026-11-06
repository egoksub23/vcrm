import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { buildTicketPatch } from "@/lib/tickets/patch";
import { resolutionErrorCode } from "@/lib/tickets/resolution";
import type { Ticket } from "@/types";

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
    const ids = body?.ids ?? [];
    if (ids.length === 0) return NextResponse.json({ ok: true });
    const { error } = await ctx.supabase
      .from("tickets")
      .delete()
      .in("id", ids)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { ids?: string[]; patch?: Partial<Ticket> } | null;
    const ids = body?.ids ?? [];
    if (ids.length === 0) return NextResponse.json({ ok: true, patch: {} });

    const full = buildTicketPatch(body?.patch ?? {});
    const { error } = await ctx.supabase
      .from("tickets")
      .update(full)
      .in("id", ids)
      .eq("account_id", ctx.accountId);

    if (error) {
      console.error("[updateTickets] failed:", error);
      const code = resolutionErrorCode(error) ?? "other";
      return NextResponse.json({ ok: false, code }, { status: 422 });
    }
    return NextResponse.json({ ok: true, patch: full });
  } catch (err) {
    return toErrorResponse(err);
  }
}
