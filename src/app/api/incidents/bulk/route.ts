// POST /api/incidents/bulk
// Bulk operations on a set of incidents the caller selects by ID.
// Requires incidents.manage. All incident IDs must belong to the caller's school.
//   { action: "export-csv", ids: string[] }              — returns a CSV download
//   { action: "assign-lead", ids: string[], leadId: string } — sets the lead on each
//   { action: "change-status", ids: string[], status: string } — changes status on each
//                                                              (workflow requirements still apply — skips any that don't meet them)
// Partial success is not an error: the response reports how many succeeded and how many were skipped.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { loadRegisterRows, loadNamesForStandards } from "@/lib/incidents/platform/records-data";
import { registerCsv } from "@/lib/incidents/platform/registers";

const BASE_STATUSES = new Set(["reported", "triaged", "contained", "investigating", "recovered", "closed"]);
const MAX_BULK = 500;

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const action = typeof body?.action === "string" ? body.action : null;
    const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, MAX_BULK) : null;

    if (!action || !ids || ids.length === 0) {
      return NextResponse.json({ error: "Provide action and ids." }, { status: 400 });
    }

    // Verify all IDs belong to this school.
    const { data: check } = await ctx.supabase.from("incidents").select("id").in("id", ids).eq("account_id", ctx.accountId);
    const ownedIds = new Set(((check ?? []) as { id: string }[]).map((r) => r.id));
    const validIds = ids.filter((id) => ownedIds.has(id));
    if (validIds.length === 0) return NextResponse.json({ error: "None of the provided incident IDs belong to this school." }, { status: 404 });

    // ── export-csv ──────────────────────────────────────────────────────────────
    if (action === "export-csv") {
      const { rows } = await loadRegisterRows(ctx.supabase, ctx.accountId);
      const selected = rows.filter((r) => validIds.includes(r.id));
      const names = await loadNamesForStandards(ctx.supabase, ctx.accountId, selected.map((r) => (r as { standard_id?: string | null }).standard_id));
      const catMap = new Map(names.categories.map((c) => [c.code, c.name]));
      const sevMap = new Map(names.severities.map((s) => [s.slug, s.label]));
      const csv = registerCsv(selected, {
        category: (code) => catMap.get(code) ?? code,
        severity: (slug) => sevMap.get(slug) ?? slug,
      });
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="incidents-bulk-${Date.now()}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // ── assign-lead ─────────────────────────────────────────────────────────────
    if (action === "assign-lead") {
      const leadId = typeof body?.leadId === "string" ? body.leadId.trim() : null;
      if (!leadId) return NextResponse.json({ error: "Provide leadId." }, { status: 400 });
      const { data: profile } = await ctx.supabase.from("profiles").select("user_id, full_name").eq("user_id", leadId).eq("account_id", ctx.accountId).maybeSingle();
      if (!profile) return NextResponse.json({ error: "Lead not found in this school." }, { status: 404 });
      let updated = 0;
      for (const id of validIds) {
        const { error } = await ctx.supabase.from("incidents").update({ incident_lead_id: leadId }).eq("id", id).eq("account_id", ctx.accountId).neq("status", "closed").is("voided_at", null);
        if (!error) updated += 1;
      }
      return NextResponse.json({ updated, skipped: validIds.length - updated });
    }

    // ── change-status ────────────────────────────────────────────────────────────
    if (action === "change-status") {
      const status = typeof body?.status === "string" ? body.status.trim() : null;
      if (!status) return NextResponse.json({ error: "Provide status." }, { status: 400 });
      if (!BASE_STATUSES.has(status)) return NextResponse.json({ error: `Invalid status. Use one of: ${[...BASE_STATUSES].join(", ")}.` }, { status: 400 });
      if (status === "closed") return NextResponse.json({ error: "Use the close dialog to close an incident — bulk close is not allowed." }, { status: 400 });
      let updated = 0;
      for (const id of validIds) {
        const { error } = await ctx.supabase.from("incidents").update({ status }).eq("id", id).eq("account_id", ctx.accountId).neq("status", "closed").is("voided_at", null);
        if (!error) updated += 1;
      }
      return NextResponse.json({ updated, skipped: validIds.length - updated });
    }

    return NextResponse.json({ error: "Unknown action. Use export-csv, assign-lead, or change-status." }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
