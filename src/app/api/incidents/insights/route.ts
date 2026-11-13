// GET /api/incidents/insights — what the Reports page says: what needs attention (with the Dashboard address that lists it), a few numbers that mean something,
// and where and when incidents happen, over the last 12 months. Requires incidents.manage. Test reports are left out. Read as the signed-in person.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { buildInsights, type InsightPerson } from "@/lib/incidents/platform/insights";
import { buildOverview, type OverviewAck, type OverviewStep } from "@/lib/incidents/platform/overview";
import { loadNamesForStandards, loadRegisterRows } from "@/lib/incidents/platform/records-data";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.manage");
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString();
    const { rows } = await loadRegisterRows(ctx.supabase, ctx.accountId, since);
    const real = rows.filter((r) => !r.is_test);

    const people: InsightPerson[] = [];
    for (let i = 0; i < real.length; i += 400) {
      const { data } = await ctx.supabase.from("incident_involved").select("incident_id, name, class_name").in("incident_id", real.slice(i, i + 400).map((r) => r.id));
      people.push(...((data ?? []) as InsightPerson[]));
    }

    const [names, steps, ack] = await Promise.all([
      loadNamesForStandards(ctx.supabase, ctx.accountId, real.map((r) => (r as { standard_id?: string | null }).standard_id)),
      ctx.supabase.from("incident_obligations").select("id, incident_id, title, due_at, role_key").eq("account_id", ctx.accountId).eq("status", "open").not("due_at", "is", null).limit(1000),
      ctx.supabase.from("incident_ack_state").select("incident_id, first_ask_at, acknowledged").eq("account_id", ctx.accountId).limit(1000),
    ]);
    // The Dashboard's own sets, so a number here is the same number there.
    const overview = buildOverview({
      incidents: real,
      steps: (steps.data ?? []) as OverviewStep[],
      ack: (ack.data ?? []) as OverviewAck[],
      categories: names.categories,
      now,
    });

    const pick = <T extends { name?: string; label?: string; code?: string; slug?: string }>(list: T[] | undefined, key: string, field: "name" | "label", by: "code" | "slug") =>
      (list ?? []).find((x) => x[by] === key)?.[field];
    const insights = buildInsights({
      rows: real,
      people,
      overdueIds: new Set(overview.overdueIds),
      unackIds: new Set(overview.unacknowledgedIds),
      names: {
        category: (code, sid) => pick(sid ? names.byStandard.get(sid)?.categories : undefined, code, "name", "code") ?? pick(names.categories, code, "name", "code") ?? code,
        severity: (slug, sid) => pick(sid ? names.byStandard.get(sid)?.severities : undefined, slug, "label", "slug") ?? pick(names.severities, slug, "label", "slug") ?? slug,
      },
      now,
    });
    return NextResponse.json({ insights }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
