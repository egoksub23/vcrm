// ============================================================
// /api/incidents/settings/standard
//
//   GET  — returns all available incident standards from the catalogue,
//          with the type and severity counts, and which one is active for
//          this account.
//
//   PATCH — body `{ standard_id: string }`. Switches the account's active
//           incident standard: sets is_active = false on every other row
//           in account_incident_standards for this account, then upserts
//           the target standard as is_active = true.
//           Requires the `incidents.manage` capability.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  void request;
  try {
    const ctx = await requireCapability("incidents.manage");

    const [standardsRes, activeRes, countsRes] = await Promise.all([
      ctx.supabase
        .from("incident_standards")
        .select("id, slug, name, regulatory_body, sector, description")
        .order("created_at"),
      ctx.supabase
        .from("account_incident_standards")
        .select("standard_id")
        .eq("account_id", ctx.accountId)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle(),
      Promise.all([
        ctx.supabase.from("incident_type_catalogue").select("standard_id"),
        ctx.supabase.from("incident_severity_levels").select("standard_id"),
      ]),
    ]);

    if (standardsRes.error) {
      return NextResponse.json({ error: "Failed to load standards" }, { status: 500 });
    }

    const [typesRes, sevRes] = countsRes;
    const typeCounts = new Map<string, number>();
    const sevCounts = new Map<string, number>();
    for (const row of typesRes.data ?? []) {
      typeCounts.set(row.standard_id, (typeCounts.get(row.standard_id) ?? 0) + 1);
    }
    for (const row of sevRes.data ?? []) {
      sevCounts.set(row.standard_id, (sevCounts.get(row.standard_id) ?? 0) + 1);
    }

    const activeId = activeRes.data?.standard_id ?? null;

    return NextResponse.json({
      standards: (standardsRes.data ?? []).map((s) => ({
        ...s,
        type_count: typeCounts.get(s.id) ?? 0,
        severity_count: sevCounts.get(s.id) ?? 0,
        is_active: s.id === activeId,
      })),
      active_standard_id: activeId,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability("incidents.manage");

    const body = (await request.json().catch(() => null)) as { standard_id?: unknown } | null;
    const standardId = body?.standard_id;

    if (!standardId || typeof standardId !== "string") {
      return NextResponse.json({ error: "standard_id is required" }, { status: 400 });
    }

    // Verify the standard exists
    const { data: std, error: stdError } = await ctx.supabase
      .from("incident_standards")
      .select("id, name")
      .eq("id", standardId)
      .single();

    if (stdError || !std) {
      return NextResponse.json({ error: "Standard not found" }, { status: 404 });
    }

    // Deactivate all current standards for this account
    await ctx.supabase
      .from("account_incident_standards")
      .update({ is_active: false })
      .eq("account_id", ctx.accountId)
      .neq("standard_id", standardId);

    // Upsert the target standard as active
    const { error: upsertError } = await ctx.supabase
      .from("account_incident_standards")
      .upsert(
        {
          account_id: ctx.accountId,
          standard_id: standardId,
          is_active: true,
          activated_at: new Date().toISOString(),
        },
        { onConflict: "account_id,standard_id" },
      );

    if (upsertError) {
      console.error("[PATCH /api/incidents/settings/standard] upsert error:", upsertError);
      return NextResponse.json({ error: "Failed to switch standard" }, { status: 500 });
    }

    return NextResponse.json({ active_standard_id: standardId, name: std.name });
  } catch (err) {
    return toErrorResponse(err);
  }
}
