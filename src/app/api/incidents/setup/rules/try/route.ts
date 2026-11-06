// POST /api/incidents/setup/rules/try — "Try it". Body: { category, severity, flags[] } describing a sample incident.
// Answers with who would be told, how and when, and what is missing (a role with nobody in it). Sends nothing and writes nothing.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { isIncidentFlag } from "@/lib/incidents/constants";
import { planRules, type IncidentRule } from "@/lib/incidents/platform/rules";
import { labelOf } from "@/lib/incidents/platform/roles";
import { loadDirectory, previewResolver } from "@/lib/incidents/platform/setup-data";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as { category?: unknown; severity?: unknown; flags?: unknown } | null;
    const category = typeof body?.category === "string" ? body.category : "";
    const severity = typeof body?.severity === "string" ? body.severity : "";
    const flags = Array.isArray(body?.flags) ? (body!.flags as unknown[]).filter(isIncidentFlag) : [];
    if (!category || !severity) return NextResponse.json({ error: "Pick a category and a severity for the sample." }, { status: 400 });

    const [rulesRes, directory] = await Promise.all([
      ctx.supabase.from("incident_rules").select("*").eq("account_id", ctx.accountId).order("position"),
      loadDirectory(ctx.supabase, ctx.accountId),
    ]);
    const rules = (rulesRes.data ?? []) as IncidentRule[];
    const roleName = (key: string) => labelOf(directory.roles.find((r) => r.key === key)?.name) || key;

    const plan = planRules({ rules, facts: { category, severity, flags }, resolveRole: previewResolver(directory), roleName });
    return NextResponse.json({
      notices: plan.notices.map((n) => ({
        after: n.after,
        ruleName: n.ruleName,
        roleKey: n.roleKey,
        roleName: roleName(n.roleKey),
        askAck: n.askAck,
        people: n.resolve.recipients.map((r) => ({ name: r.name, address: r.address })),
        warnings: n.resolve.warnings,
      })),
      escalations: plan.escalations,
      warnings: plan.warnings,
      enabledRules: rules.filter((r) => r.enabled).length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
