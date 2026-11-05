// ============================================================
// /api/incidents/settings/standard
//
//   GET  — returns every incident standard from the catalogue: templates
//          (categories + one severity scale) and frameworks (obligation
//          packs), with their counts and whether each is active for this
//          account.
//
//   PATCH — body `{ standard_id: string, is_active?: boolean }`.
//           * a TEMPLATE is switched to: it becomes the account's one active
//             template (the database trigger from migration 206 deactivates
//             the previous one). A template cannot be switched off — pick
//             another instead.
//           * a FRAMEWORK is switched on or off (default on). Any number can
//             be active at once.
//           Requires the `incidents.manage` capability.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  void request;
  try {
    const ctx = await requireCapability("incidents.manage");

    const [standardsRes, activeRes, typesRes, sevRes, rulesRes] = await Promise.all([
      ctx.supabase
        .from("incident_standards")
        .select("id, slug, name, regulatory_body, sector, description, kind")
        .order("created_at"),
      ctx.supabase
        .from("account_incident_standards")
        .select("standard_id")
        .eq("account_id", ctx.accountId)
        .eq("is_active", true),
      ctx.supabase.from("incident_type_catalogue").select("standard_id"),
      ctx.supabase.from("incident_severity_levels").select("standard_id"),
      ctx.supabase.from("incident_obligation_rules").select("standard_id"),
    ]);

    if (standardsRes.error) {
      return NextResponse.json({ error: "Failed to load standards" }, { status: 500 });
    }

    const countBy = (rows: { standard_id: string }[] | null) => {
      const counts = new Map<string, number>();
      for (const row of rows ?? []) counts.set(row.standard_id, (counts.get(row.standard_id) ?? 0) + 1);
      return counts;
    };
    const typeCounts = countBy(typesRes.data);
    const sevCounts = countBy(sevRes.data);
    const ruleCounts = countBy(rulesRes.data);

    const activeIds = new Set((activeRes.data ?? []).map((r: { standard_id: string }) => r.standard_id));

    const standards = (standardsRes.data ?? []).map((s: { id: string; kind: string }) => ({
      ...s,
      type_count: typeCounts.get(s.id) ?? 0,
      severity_count: sevCounts.get(s.id) ?? 0,
      rule_count: ruleCounts.get(s.id) ?? 0,
      is_active: activeIds.has(s.id),
    }));

    return NextResponse.json({
      standards,
      active_standard_id: standards.find((s: { kind: string; is_active: boolean }) => s.kind === "template" && s.is_active)?.id ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability("incidents.manage");

    const body = (await request.json().catch(() => null)) as
      | { standard_id?: unknown; is_active?: unknown }
      | null;
    const standardId = body?.standard_id;

    if (!standardId || typeof standardId !== "string") {
      return NextResponse.json({ error: "standard_id is required" }, { status: 400 });
    }
    if (body?.is_active !== undefined && typeof body.is_active !== "boolean") {
      return NextResponse.json({ error: "is_active must be true or false" }, { status: 400 });
    }
    const isActive = body?.is_active ?? true;

    const { data: std, error: stdError } = await ctx.supabase
      .from("incident_standards")
      .select("id, name, kind")
      .eq("id", standardId)
      .single();

    if (stdError || !std) {
      return NextResponse.json({ error: "Standard not found" }, { status: 404 });
    }

    if (std.kind === "template" && !isActive) {
      return NextResponse.json(
        { error: "An account always has one incident template. Switch to another template instead." },
        { status: 400 },
      );
    }

    const { error: upsertError } = await ctx.supabase
      .from("account_incident_standards")
      .upsert(
        {
          account_id: ctx.accountId,
          standard_id: standardId,
          is_active: isActive,
          activated_at: new Date().toISOString(),
        },
        { onConflict: "account_id,standard_id" },
      );

    if (upsertError) {
      console.error("[PATCH /api/incidents/settings/standard] upsert error:", upsertError);
      return NextResponse.json({ error: "Failed to update standard" }, { status: 500 });
    }

    return NextResponse.json({
      standard_id: standardId,
      kind: std.kind,
      is_active: isActive,
      name: std.name,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
