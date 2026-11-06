// /api/incidents/setup/retention — how long the school keeps incident records.
//   GET  the setting and the last few exports and deletes.
//   PUT  { years: number | null }  (null = keep until the school deletes them, the default).
// Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseRetentionYears } from "@/lib/incidents/platform/retention";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const [settings, log] = await Promise.all([
      ctx.supabase.from("incident_settings").select("retention_years").eq("account_id", ctx.accountId).maybeSingle(),
      ctx.supabase.from("incident_retention_log").select("id, action, cutoff, incident_count, file_count, created_at").eq("account_id", ctx.accountId).order("created_at", { ascending: false }).limit(10),
    ]);
    return NextResponse.json({ years: (settings.data as { retention_years: number | null } | null)?.retention_years ?? null, log: log.data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as { years?: unknown } | null;
    const parsed = parseRetentionYears(body?.years);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { error } = await ctx.supabase
      .from("incident_settings")
      .upsert({ account_id: ctx.accountId, retention_years: parsed.value, updated_by: ctx.userId }, { onConflict: "account_id" });
    if (error) return NextResponse.json({ error: "Could not save the setting." }, { status: 500 });
    return NextResponse.json({ years: parsed.value });
  } catch (err) {
    return toErrorResponse(err);
  }
}
