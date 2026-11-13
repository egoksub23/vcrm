// /api/incidents/setup/pack — the school's OWN required steps (migration 216). Requires incidents.configure.
//   GET   the school's pack (or null) with its steps, and the roles a step can be given to.
//   POST  { action: "create" }                         start the pack and switch it on
//         { action: "save", id?, title, description?, trigger_flag, due_hours?, role_key? }   add or change a step
//         { action: "remove", id }                      delete a step
// A step is added to every NEW incident that involves what it names. Incidents already raised keep the steps they have.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { MAX_PACK_RULES, nextStepCode, packSlug, parsePackRule } from "@/lib/incidents/platform/pack";
import { labelOf } from "@/lib/incidents/platform/roles";
import { ensureStarterRoles } from "@/lib/incidents/platform/setup-data";
import { createAdminPgDb } from "@/lib/postgres/db";

type Ctx = Awaited<ReturnType<typeof requireCapability>>;
type Step = { id: string; code: string; title: string; description: string | null; trigger_flag: string; due_hours: number | null; role_key: string | null; position: number };

async function load(ctx: Ctx) {
  const { data: pack } = await ctx.supabase.from("incident_standards").select("id, name").eq("account_id", ctx.accountId).eq("kind", "framework").maybeSingle();
  const std = pack as { id: string; name: string } | null;
  const [steps, roles, active] = await Promise.all([
    std ? ctx.supabase.from("incident_obligation_rules").select("id, code, title, description, trigger_flag, due_hours, role_key, position").eq("standard_id", std.id).order("position") : Promise.resolve({ data: [] }),
    ctx.supabase.from("incident_roles").select("key, name, kind").eq("account_id", ctx.accountId).order("sort_order"),
    std ? ctx.supabase.from("account_incident_standards").select("is_active").eq("account_id", ctx.accountId).eq("standard_id", std.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return {
    std,
    steps: (steps.data ?? []) as Step[],
    roles: ((roles.data ?? []) as { key: string; name: Record<string, string>; kind: string }[]).filter((r) => r.kind === "fixed").map((r) => ({ key: r.key, name: labelOf(r.name) })),
    active: (active.data as { is_active: boolean } | null)?.is_active ?? false,
  };
}

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    await ensureStarterRoles(ctx.accountId);
    const { std, steps, roles, active } = await load(ctx);
    return NextResponse.json({ pack: std, steps, roles, active });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const { std, steps, roles } = await load(ctx);

    switch (body?.action) {
      case "create": {
        if (std) return NextResponse.json({ error: "The school already has its own pack." }, { status: 409 });
        const { data, error } = await ctx.supabase
          .from("incident_standards")
          .insert({ slug: packSlug(ctx.accountId), name: "Our school's own steps", description: "Required steps the school added itself.", kind: "framework", is_system: false, account_id: ctx.accountId })
          .select("id")
          .single();
        if (error || !data) {
          console.error("[POST pack create]", error);
          return NextResponse.json({ error: "Could not start the pack." }, { status: 500 });
        }
        // Switch it on (the settings table is written with the service connection after the capability check above).
        await createAdminPgDb().from("account_incident_standards").upsert({ account_id: ctx.accountId, standard_id: (data as { id: string }).id, is_active: true, activated_at: new Date().toISOString() }, { onConflict: "account_id,standard_id" });
        return NextResponse.json({ ok: true }, { status: 201 });
      }
      case "save": {
        if (!std) return NextResponse.json({ error: "Start the pack first." }, { status: 409 });
        const parsed = parsePackRule(body, roles.map((r) => r.key));
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        const v = parsed.value;
        const row = { title: v.title, description: v.description, trigger_flag: v.triggerFlag, due_hours: v.dueHours, role_key: v.roleKey, party: null };
        if (typeof body.id === "string") {
          const { data, error } = await ctx.supabase.from("incident_obligation_rules").update(row).eq("id", body.id).eq("standard_id", std.id).select("id").maybeSingle();
          if (error) return NextResponse.json({ error: "Could not save the step." }, { status: 500 });
          if (!data) return NextResponse.json({ error: "Step not found." }, { status: 404 });
          return NextResponse.json({ ok: true });
        }
        if (steps.length >= MAX_PACK_RULES) return NextResponse.json({ error: `A pack can have at most ${MAX_PACK_RULES} steps.` }, { status: 409 });
        const { error } = await ctx.supabase.from("incident_obligation_rules").insert({ ...row, standard_id: std.id, code: nextStepCode(steps.map((s) => s.code)), position: steps.length + 1 });
        if (error) return NextResponse.json({ error: "Could not add the step." }, { status: 500 });
        return NextResponse.json({ ok: true }, { status: 201 });
      }
      case "remove": {
        if (!std || typeof body.id !== "string") return NextResponse.json({ error: "Step not found." }, { status: 404 });
        const { error } = await ctx.supabase.from("incident_obligation_rules").delete().eq("id", body.id).eq("standard_id", std.id);
        if (error) return NextResponse.json({ error: "Could not delete the step." }, { status: 500 });
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
