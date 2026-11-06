// POST /api/conversations/bulk
// Body: { action: "assign"|"markRead"|"markUnread", ids: string[], agentId?: string|null }
import { NextResponse } from "next/server";
import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { notifyVircleRead } from "@/lib/vircle-chat/client";
import type { Conversation } from "@/types";

type ConvRef = Pick<Conversation, "id" | "unread_count"> & Partial<Pick<Conversation, "last_channel_type">>;

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("conversations.manage");
    const body = (await request.json().catch(() => null)) as {
      action?: string;
      ids?: string[];
      convs?: ConvRef[];
      agentId?: string | null;
    } | null;
    if (!body?.action) return NextResponse.json({ error: "action required" }, { status: 400 });

    if (body.action === "assign") {
      const ids = body.ids ?? [];
      if (ids.length === 0) return NextResponse.json({ succeeded: [], failed: 0 });
      const { error } = await ctx.supabase
        .from("conversations")
        .update({ assigned_agent_id: body.agentId ?? null })
        .in("id", ids)
        .eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ succeeded: [], failed: ids.length });
      return NextResponse.json({ succeeded: ids, failed: 0 });
    }

    if (body.action === "markRead") {
      const convs: ConvRef[] = body.convs ?? [];
      const ids = convs.filter((c) => c.unread_count > 0).map((c) => c.id);
      if (ids.length === 0) return NextResponse.json({ succeeded: [], failed: 0 });
      const { error } = await ctx.supabase
        .from("conversations")
        .update({ unread_count: 0 })
        .in("id", ids)
        .eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ succeeded: [], failed: ids.length });
      for (const c of convs) {
        if (c.unread_count > 0 && c.last_channel_type === "vircle_chat") notifyVircleRead(c.id);
      }
      return NextResponse.json({ succeeded: ids, failed: 0 });
    }

    if (body.action === "markUnread") {
      const convs: ConvRef[] = body.convs ?? [];
      const ids = convs.filter((c) => c.unread_count === 0).map((c) => c.id);
      if (ids.length === 0) return NextResponse.json({ succeeded: [], failed: 0 });
      const { error } = await ctx.supabase
        .from("conversations")
        .update({ unread_count: 1 })
        .in("id", ids)
        .eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ succeeded: [], failed: ids.length });
      return NextResponse.json({ succeeded: ids, failed: 0 });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
