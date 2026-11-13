// /api/incidents/setup/timing — the timing a school can change (migration 218). Requires incidents.configure.
//   GET   the acknowledgement wait, and every step of the school's switched-on built-in packs with the shipped deadline and the school's own choice.
//   PUT   { ack_wait_minutes }   set the wait; the school's "nobody acknowledged" rule from the starter recipe follows it.
//   POST  { action: "step", rule_id, mode: "default" | "hours" | "none", hours?, enabled? }   the deadline of one built-in step, and whether it is on.
// Changes apply to incidents raised from now on. Incidents already raised keep the steps and dates they have.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { labelOf } from "@/lib/incidents/platform/roles";
import { ensureStarterRoles } from "@/lib/incidents/platform/setup-data";
import { ACK_RECIPE_KEY, DEFAULT_ACK_WAIT_MINUTES, LEGAL_PACK_SLUGS, modeOf, parseAckWait, parseStepSetting, toOverrideRow, type StoredOverride } from "@/lib/incidents/platform/timing";

type Ctx = Awaited<ReturnType<typeof requireCapability>>;
type Rule = { id: string; standard_id: string; code: string; title: string; trigger_flag: string; due_hours: number | null; role_key: string | null; position: number };

/** The switched-on packs that ship with the product (not the school's own, which has its own screen). */
async function builtInPacks(ctx: Ctx) {
  const { data: active } = await ctx.supabase.from("account_incident_standards").select("standard_id").eq("account_id", ctx.accountId).eq("is_active", true);
  const ids = ((active ?? []) as { standard_id: string }[]).map((a) => a.standard_id);
  if (ids.length === 0) return [];
  const { data } = await ctx.supabase.from("incident_standards").select("id, slug, name").in("id", ids).eq("kind", "framework").is("account_id", null).order("name");
  return (data ?? []) as { id: string; slug: string; name: string }[];
}

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    await ensureStarterRoles(ctx.accountId);
    const packs = await builtInPacks(ctx);
    const [settings, rules, overrides, roles] = await Promise.all([
      ctx.supabase.from("incident_settings").select("ack_wait_minutes").eq("account_id", ctx.accountId).maybeSingle(),
      packs.length ? ctx.supabase.from("incident_obligation_rules").select("id, standard_id, code, title, trigger_flag, due_hours, role_key, position").in("standard_id", packs.map((p) => p.id)).order("position") : Promise.resolve({ data: [] }),
      ctx.supabase.from("incident_step_overrides").select("rule_id, due_hours, no_deadline, enabled").eq("account_id", ctx.accountId),
      ctx.supabase.from("incident_roles").select("key, name, kind").eq("account_id", ctx.accountId),
    ]);
    const ov = new Map(((overrides.data ?? []) as (StoredOverride & { rule_id: string })[]).map((o) => [o.rule_id, o]));
    const ruleRows = (rules.data ?? []) as Rule[];
    return NextResponse.json({
      ack_wait_minutes: (settings.data as { ack_wait_minutes: number } | null)?.ack_wait_minutes ?? DEFAULT_ACK_WAIT_MINUTES,
      default_ack_wait_minutes: DEFAULT_ACK_WAIT_MINUTES,
      roles: ((roles.data ?? []) as { key: string; name: Record<string, string> }[]).map((r) => ({ key: r.key, name: labelOf(r.name) })),
      packs: packs.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        legal: LEGAL_PACK_SLUGS.includes(p.slug),
        steps: ruleRows
          .filter((r) => r.standard_id === p.id)
          .map((r) => {
            const o = ov.get(r.id) ?? null;
            return { id: r.id, title: r.title, trigger_flag: r.trigger_flag, role_key: r.role_key, shipped_hours: r.due_hours, mode: modeOf(o), hours: o?.due_hours ?? null, enabled: o?.enabled ?? true };
          }),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as { ack_wait_minutes?: unknown } | null;
    const parsed = parseAckWait(body?.ack_wait_minutes);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { error } = await ctx.supabase
      .from("incident_settings")
      .upsert({ account_id: ctx.accountId, ack_wait_minutes: parsed.value, updated_by: ctx.userId }, { onConflict: "account_id" });
    if (error) return NextResponse.json({ error: "Could not save the setting." }, { status: 500 });
    // The rule that came from the starter recipe follows the setting. A rule the school wrote itself is not touched.
    const { data: updated } = await ctx.supabase.from("incident_rules").update({ wait_minutes: parsed.value }).eq("account_id", ctx.accountId).eq("recipe_key", ACK_RECIPE_KEY).select("id");
    return NextResponse.json({ ack_wait_minutes: parsed.value, rules_updated: (updated ?? []).length });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.action !== "step") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const parsed = parseStepSetting(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const s = parsed.value;

    // Only a step of a built-in pack the school has switched on can be changed here.
    const allowed = new Set<string>();
    const packs = await builtInPacks(ctx);
    if (packs.length) {
      const { data } = await ctx.supabase.from("incident_obligation_rules").select("id").in("standard_id", packs.map((p) => p.id));
      for (const r of (data ?? []) as { id: string }[]) allowed.add(r.id);
    }
    if (!allowed.has(s.ruleId)) return NextResponse.json({ error: "Step not found." }, { status: 404 });

    const row = toOverrideRow(s);
    if (row === null) {
      const { error } = await ctx.supabase.from("incident_step_overrides").delete().eq("account_id", ctx.accountId).eq("rule_id", s.ruleId);
      if (error) return NextResponse.json({ error: "Could not save the step." }, { status: 500 });
    } else {
      const { error } = await ctx.supabase
        .from("incident_step_overrides")
        .upsert({ account_id: ctx.accountId, rule_id: s.ruleId, ...row, updated_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: "account_id,rule_id" });
      if (error) return NextResponse.json({ error: "Could not save the step." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
