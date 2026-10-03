// ============================================================
// GET /api/platform/usage — every workspace's latest usage beside its limits
// (migration 152), for the operator console. Numbers are the daily snapshot,
// so this is cheap however many workspaces there are.
//
// Operator only (requirePlatformAdmin); platform_usage_overview() re-checks.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { usageMeters, worstState, type AccountUsage } from "@/lib/platform/usage";

interface OverviewRow {
  account_id: string;
  name: string;
  plan: string;
  limits: Record<string, number>;
  day: string | null;
  contacts: number | null;
  members: number | null;
  conversations: number | null;
  messages_month: number | null;
  storage_bytes: number | null;
  ai_tokens_month: number | null;
}

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    const { data, error } = await ctx.supabase.rpc("platform_usage_overview");
    if (error) {
      console.error("[GET /api/platform/usage] rpc error:", error);
      return NextResponse.json({ error: "Failed to load usage" }, { status: 500 });
    }
    const accounts = ((data ?? []) as OverviewRow[]).map((r) => {
      const measured = r.day !== null;
      const meters = measured
        ? usageMeters({
            contacts: r.contacts ?? 0,
            members: r.members ?? 0,
            conversations: r.conversations ?? 0,
            messages_month: r.messages_month ?? 0,
            ai_tokens_month: r.ai_tokens_month ?? 0,
            storage_bytes: r.storage_bytes ?? 0,
            storage_measured_at: r.day,
            limits: r.limits ?? {},
          } satisfies AccountUsage)
        : [];
      return {
        accountId: r.account_id,
        name: r.name,
        plan: r.plan,
        measuredDay: r.day,
        meters,
        state: worstState(meters),
      };
    });
    return NextResponse.json({ accounts }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
