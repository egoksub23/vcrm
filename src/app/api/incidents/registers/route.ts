// GET /api/incidents/registers?register=injury&from=2026-01-01&to=2026-03-31[&format=csv]
// A register is a view of the school's incidents: injuries, data breaches, near misses, property damage, safeguarding, or everything. Requires incidents.manage;
// the CSV also needs incidents.export. Test reports are listed (marked) so the school can see them, and left out of the trends.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { inRange, inRegister, isRegister, parseRange, registerCsv } from "@/lib/incidents/platform/registers";
import { loadNames, loadRegisterRows } from "@/lib/incidents/platform/records-data";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const url = new URL(request.url);
    const register = url.searchParams.get("register") ?? "all";
    if (!isRegister(register)) return NextResponse.json({ error: "Unknown register." }, { status: 400 });
    const range = parseRange(url.searchParams);
    if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });
    const csv = url.searchParams.get("format") === "csv";
    if (csv && !ctx.capabilities.has("incidents.export")) return NextResponse.json({ error: "Downloading a register needs the export permission." }, { status: 403 });

    const [{ rows, truncated }, names] = await Promise.all([loadRegisterRows(ctx.supabase, ctx.accountId, range.range.from ? `${range.range.from}T00:00:00Z` : null), loadNames(ctx.supabase, ctx.accountId)]);
    const selected = rows.filter((r) => inRange(r, range.range) && inRegister(r, register, names.categories));

    if (csv) {
      const cat = new Map(names.categories.map((c) => [c.code, c.name]));
      const sev = new Map(names.severities.map((s) => [s.slug, s.label]));
      const body = registerCsv(selected, { category: (c) => cat.get(c) ?? c, severity: (s) => sev.get(s) ?? s });
      return new NextResponse(body, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="incident-register-${register}-${new Date().toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ rows: selected, truncated, categories: Object.fromEntries(names.categories.map((c) => [c.code, c.name])), severities: Object.fromEntries(names.severities.map((s) => [s.slug, s.label])), canExport: ctx.capabilities.has("incidents.export") });
  } catch (err) {
    return toErrorResponse(err);
  }
}
