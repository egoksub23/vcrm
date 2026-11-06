// GET /api/incidents/setup/portal — everything the "Coach portal & API" page shows: the keys (never the key itself, only its first characters), the last calls,
// Halo's public address, the hand-off guide, and the retention setting. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { buildHandoffGuide } from "@/lib/incidents/intake/admin";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const [keys, calls, settings] = await Promise.all([
      ctx.supabase
        .from("incident_intake_keys")
        .select("id, label, mode, prefix, scopes, allowed_origins, webhook_url, created_at, last_used_at, revoked_at")
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false }),
      ctx.supabase.from("incident_intake_calls").select("id, route, status, summary, created_at").eq("account_id", ctx.accountId).order("created_at", { ascending: false }).limit(15),
      ctx.supabase.from("incident_settings").select("retention_years").eq("account_id", ctx.accountId).maybeSingle(),
    ]);
    const rows = (keys.data ?? []) as { id: string; label: string; mode: string; prefix: string; scopes: string[]; allowed_origins: string[]; webhook_url: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }[];
    const address = process.env.NEXT_PUBLIC_SITE_URL?.trim() || null;
    const live = rows.find((k) => k.mode === "live" && !k.revoked_at) ?? rows.find((k) => !k.revoked_at) ?? null;
    return NextResponse.json({
      keys: rows,
      calls: calls.data ?? [],
      address,
      retentionYears: (settings.data as { retention_years: number | null } | null)?.retention_years ?? null,
      guide: buildHandoffGuide({ address, keyPrefix: live?.prefix ?? null, origins: live?.allowed_origins ?? [] }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
