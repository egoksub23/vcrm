// /api/incidents/setup/statuses — the school's incident statuses. Requires incidents.configure.
//   GET   every status (the six built-in ones, with the school's wording, and its extras), and how many incidents are in each extra one
//   POST  { action: "add", label, base }       add an extra status that counts as one of the six
//         { action: "rename", key, label }     rename any status
//         { action: "hide", key, active }      switch an extra status off (or on): it is no longer offered, incidents in it keep it
//         { action: "delete", key }            delete an extra status nothing is in
// The six built-in statuses stay: timers, rules, requirements and reports work on them. Migration 226.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { changeStatuses, loadStatusesView, type StatusChange } from "@/lib/incidents/platform/statuses-data";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    return NextResponse.json(await loadStatusesView(createAdminPgDb(), ctx.accountId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as (StatusChange & { action?: unknown }) | null;
    if (!body || !["add", "rename", "hide", "delete"].includes(String(body.action))) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const db = createAdminPgDb();
    const result = await changeStatuses(db, ctx.accountId, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(await loadStatusesView(db, ctx.accountId));
  } catch (err) {
    return toErrorResponse(err);
  }
}
