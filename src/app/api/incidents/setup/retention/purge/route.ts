// POST /api/incidents/setup/retention/purge — { before: "YYYY-MM-DD", confirm: "DELETE <count>" }. Permanently deletes closed incidents up to that date, with their
// steps, comments, messages, people named and stored files. Open incidents are never touched. The person must hold incidents.configure AND incidents.export
// (they can take the export first), and must type the number being deleted. Logged.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseCutoff, purgePhrase } from "@/lib/incidents/platform/retention";
import { incidentIdsClosedBefore, purgeClosedBefore } from "@/lib/incidents/platform/retention-data";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    if (!ctx.capabilities.has("incidents.export")) return NextResponse.json({ error: "Deleting records needs the export permission too, so the records can be saved first." }, { status: 403 });
    const body = (await request.json().catch(() => null)) as { before?: unknown; confirm?: unknown } | null;
    const cutoff = parseCutoff(body?.before, new Date());
    if (!cutoff.ok) return NextResponse.json({ error: cutoff.error }, { status: 400 });

    const admin = createAdminPgDb();
    const count = (await incidentIdsClosedBefore(admin, ctx.accountId, cutoff.value, 10_000)).length;
    if (count === 0) return NextResponse.json({ error: "No closed incidents are older than that date." }, { status: 404 });
    if (body?.confirm !== purgePhrase(count)) {
      return NextResponse.json({ error: `To confirm, type ${purgePhrase(count)}.`, count }, { status: 409 });
    }
    const result = await purgeClosedBefore(admin, ctx.accountId, cutoff.value, ctx.userId, false);
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
