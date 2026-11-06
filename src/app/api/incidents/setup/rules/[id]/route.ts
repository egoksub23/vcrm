// PATCH /api/incidents/setup/rules/[id] — switch on/off, rename, or change a rule. DELETE removes it (messages already sent stay in the log).
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { validateRule, type IncidentRule, type RuleAction, type RuleConditions } from "@/lib/incidents/platform/rules";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Send the changes." }, { status: 400 });

    const { data: cur } = await ctx.supabase.from("incident_rules").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!cur) return NextResponse.json({ error: "Rule not found." }, { status: 404 });
    const rule = cur as IncidentRule;

    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
      patch.enabled = body.enabled;
    }
    const editsContent = ["name", "wait_minutes", "conditions", "actions"].some((k) => body[k] !== undefined);
    if (editsContent) {
      const next = {
        name: typeof body.name === "string" ? body.name : rule.name,
        trigger: rule.trigger,
        wait_minutes: body.wait_minutes === undefined ? rule.wait_minutes : (body.wait_minutes as number | null),
        conditions: (body.conditions === undefined ? rule.conditions : body.conditions) as RuleConditions,
        actions: (body.actions === undefined ? rule.actions : body.actions) as RuleAction[],
      };
      const { data: roles } = await ctx.supabase.from("incident_roles").select("key").eq("account_id", ctx.accountId);
      const problems = validateRule(next, ((roles ?? []) as { key: string }[]).map((r) => r.key));
      if (problems.length) return NextResponse.json({ error: problems[0], problems }, { status: 400 });
      Object.assign(patch, { name: next.name.trim(), wait_minutes: next.wait_minutes, conditions: next.conditions, actions: next.actions });
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    const { data, error } = await ctx.supabase.from("incident_rules").update(patch).eq("id", id).eq("account_id", ctx.accountId).select("*").maybeSingle();
    if (error) return NextResponse.json({ error: "Could not save the changes." }, { status: 500 });
    return NextResponse.json({ rule: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const { error } = await ctx.supabase.from("incident_rules").delete().eq("id", id).eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: "Could not delete the rule." }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
