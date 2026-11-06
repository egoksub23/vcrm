import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import type {
  IncidentObligationRule,
  IncidentStandard,
  StandardCatalogue,
} from "@/lib/incidents/standard-types";

const STANDARD_COLUMNS = "id, slug, name, regulatory_body, sector, description, is_system, kind, created_at";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data: rows, error } = await ctx.supabase
      .from("account_incident_standards")
      .select(`standard_id, incident_standards!inner(${STANDARD_COLUMNS})`)
      .eq("account_id", ctx.accountId)
      .eq("is_active", true);
    if (error || !rows) {
      return NextResponse.json({ config: null });
    }

    const active: IncidentStandard[] = [];
    for (const row of rows) {
      const raw = (row as { incident_standards: unknown }).incident_standards;
      const std = (Array.isArray(raw) ? raw[0] : raw) as IncidentStandard | undefined;
      if (std) active.push(std);
    }
    const template = active.find((s) => s.kind === "template");
    if (!template) return NextResponse.json({ config: null });
    const frameworks = active.filter((s) => s.kind === "framework");

    const [typesRes, sevRes, rulesRes] = await Promise.all([
      ctx.supabase
        .from("incident_type_catalogue")
        .select("*")
        .eq("standard_id", template.id)
        .order("position"),
      ctx.supabase
        .from("incident_severity_levels")
        .select("*")
        .eq("standard_id", template.id)
        .order("position"),
      frameworks.length
        ? ctx.supabase
            .from("incident_obligation_rules")
            .select("*")
            .in("standard_id", frameworks.map((f) => f.id))
            .order("position")
        : Promise.resolve({ data: [] as IncidentObligationRule[] }),
    ]);

    return NextResponse.json({
      config: {
        standard: template,
        types: typesRes.data ?? [],
        severities: sevRes.data ?? [],
        frameworks,
        rules: (rulesRes as { data: IncidentObligationRule[] }).data ?? [],
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
