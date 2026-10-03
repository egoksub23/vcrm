// ============================================================
// GET /api/account/usage  (settings.workspace)
//
// How much of each plan limit this workspace has used (migration 152): the
// live numbers from account_usage() beside the limits the operator set, with
// the same ok / warn / over reading the app enforces. The workspace's own
// admins see it in Settings > Workspace and as a notice on the dashboard.
//
// Read through the caller's own client: account_usage() re-checks the
// capability, requireCapability is the friendly early refusal.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { usageMeters, worstState, type AccountUsage } from "@/lib/platform/usage";

export async function GET() {
  try {
    const ctx = await requireCapability("settings.workspace");
    const { data, error } = await ctx.supabase.rpc("account_usage", { p_account: ctx.accountId });
    if (error || !data) {
      console.error("[GET /api/account/usage] rpc error:", error);
      return NextResponse.json({ error: "Failed to load usage" }, { status: 500 });
    }
    const usage = data as AccountUsage;
    const meters = usageMeters(usage);
    return NextResponse.json(
      { meters, state: worstState(meters), storageMeasuredAt: usage.storage_measured_at },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
