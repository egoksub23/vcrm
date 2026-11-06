// /api/incidents/setup/rules
//   GET   the school's rules, the recipe library (marked "added" when the school already has it), and what the rules need to name things
//         (the active template's categories and severity levels, the roles).
//   POST  { recipe_key } add one recipe · { starter: true } add every starter recipe not yet added ·
//         { name, trigger, wait_minutes?, conditions?, actions } add a rule written by hand.
// Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { RECIPES, validateRule, type IncidentRule, type RuleAction, type RuleConditions, type RuleDraft, type RuleTrigger } from "@/lib/incidents/platform/rules";
import { ensureStarterRoles, loadActiveTemplate, loadDirectory, seriousLevel } from "@/lib/incidents/platform/setup-data";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    await ensureStarterRoles(ctx.accountId);
    const [rulesRes, template, directory] = await Promise.all([
      ctx.supabase.from("incident_rules").select("*").eq("account_id", ctx.accountId).order("position").order("created_at"),
      loadActiveTemplate(ctx.supabase, ctx.accountId),
      loadDirectory(ctx.supabase, ctx.accountId),
    ]);
    const rules = (rulesRes.data ?? []) as IncidentRule[];
    const have = new Set(rules.map((r) => r.recipe_key).filter(Boolean));
    return NextResponse.json({
      rules,
      recipes: RECIPES.map((r) => ({ key: r.key, name: r.name, description: r.description, inStarterSet: r.inStarterSet, needs: r.needs ?? null, added: have.has(r.key) })),
      template: template && { id: template.standardId, name: template.name, categories: template.categories, severities: template.severities },
      roles: directory.roles.map((r) => ({ key: r.key, name: r.name, kind: r.kind, warnings: r.warnings })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Send the rule." }, { status: 400 });

    await ensureStarterRoles(ctx.accountId);
    const [template, directory, existing] = await Promise.all([
      loadActiveTemplate(ctx.supabase, ctx.accountId),
      loadDirectory(ctx.supabase, ctx.accountId),
      ctx.supabase.from("incident_rules").select("recipe_key, position").eq("account_id", ctx.accountId),
    ]);
    const roleKeys = directory.roles.map((r) => r.key);
    const scale = { serious: seriousLevel(template?.severities ?? []) };
    const have = new Set(((existing.data ?? []) as { recipe_key: string | null }[]).map((r) => r.recipe_key).filter(Boolean));
    let position = Math.max(0, ...((existing.data ?? []) as { position: number }[]).map((r) => r.position)) + 1;

    const toRow = (draft: RuleDraft, recipeKey: string | null) => ({
      account_id: ctx.accountId,
      recipe_key: recipeKey,
      name: draft.name.trim(),
      trigger: draft.trigger,
      wait_minutes: draft.wait_minutes,
      conditions: draft.conditions,
      actions: draft.actions,
      enabled: true,
      position: position++,
      created_by: ctx.userId,
    });

    let rows: ReturnType<typeof toRow>[] = [];
    if (body.starter === true) {
      rows = RECIPES.filter((r) => r.inStarterSet && !have.has(r.key)).map((r) => toRow(r.build(scale), r.key));
    } else if (typeof body.recipe_key === "string") {
      const recipe = RECIPES.find((r) => r.key === body.recipe_key);
      if (!recipe) return NextResponse.json({ error: "Unknown recipe." }, { status: 400 });
      if (have.has(recipe.key)) return NextResponse.json({ error: "That recipe is already added." }, { status: 409 });
      rows = [toRow(recipe.build(scale), recipe.key)];
    } else {
      const draft: RuleDraft = {
        name: typeof body.name === "string" ? body.name : "",
        trigger: body.trigger as RuleTrigger,
        wait_minutes: typeof body.wait_minutes === "number" ? body.wait_minutes : null,
        conditions: (body.conditions && typeof body.conditions === "object" ? body.conditions : {}) as RuleConditions,
        actions: Array.isArray(body.actions) ? (body.actions as RuleAction[]) : [],
      };
      const problems = validateRule(draft, roleKeys);
      if (problems.length) return NextResponse.json({ error: problems[0], problems }, { status: 400 });
      rows = [toRow(draft, null)];
    }
    if (rows.length === 0) return NextResponse.json({ rules: [], added: 0 });

    const { data, error } = await ctx.supabase.from("incident_rules").insert(rows).select("*");
    if (error) {
      console.error("[POST /api/incidents/setup/rules]", error);
      return NextResponse.json({ error: "Could not add the rule." }, { status: 500 });
    }
    return NextResponse.json({ rules: data ?? [], added: (data ?? []).length }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
