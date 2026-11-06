// POST /api/incidents/setup/import-legacy — bring the old escalation recipients (levels 2 and 3) across as roles. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { importLegacyEscalation } from "@/lib/incidents/platform/setup-data";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function POST() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const result = await importLegacyEscalation(createAdminPgDb(), ctx.accountId);
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
