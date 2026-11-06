// GET /api/incidents/setup/status — the Setup guide: which steps are done. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { buildSetupSteps } from "@/lib/incidents/platform/setup-guide";
import { loadActiveTemplate, loadDirectory } from "@/lib/incidents/platform/setup-data";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const [template, directory, rules, packs, keys, form] = await Promise.all([
      loadActiveTemplate(ctx.supabase, ctx.accountId),
      loadDirectory(ctx.supabase, ctx.accountId),
      ctx.supabase.from("incident_rules").select("enabled").eq("account_id", ctx.accountId),
      ctx.supabase.from("account_incident_standards").select("standard_id").eq("account_id", ctx.accountId).eq("is_active", true),
      ctx.supabase.from("incident_intake_keys").select("id").eq("account_id", ctx.accountId).eq("mode", "live").is("revoked_at", null),
      ctx.supabase.from("incident_form_versions").select("version").eq("account_id", ctx.accountId).eq("status", "published").maybeSingle(),
    ]);
    const activeIds = ((packs.data ?? []) as { standard_id: string }[]).map((p) => p.standard_id);
    const { data: frameworks } = activeIds.length
      ? await ctx.supabase.from("incident_standards").select("name").in("id", activeIds).eq("kind", "framework")
      : { data: [] };

    const steps = buildSetupSteps({
      templateName: template?.name ?? null,
      roles: directory.roles.map((r) => ({ kind: r.kind, memberCount: r.members.length, warnings: r.warnings.length })),
      contactCount: directory.contacts.length,
      rulesOn: ((rules.data ?? []) as { enabled: boolean }[]).filter((r) => r.enabled).length,
      packNames: ((frameworks ?? []) as { name: string }[]).map((f) => f.name),
      liveKeys: (keys.data ?? []).length,
      formVersion: (form.data as { version: number } | null)?.version ?? null,
    });
    return NextResponse.json({ steps });
  } catch (err) {
    return toErrorResponse(err);
  }
}
