// GET /api/incidents/setup/directory — the school's incident roles with their people, and every contact.
// Creates the starter roles the first time it is opened. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { ensureStarterRoles, loadDirectory } from "@/lib/incidents/platform/setup-data";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    await ensureStarterRoles(ctx.accountId);
    const directory = await loadDirectory(ctx.supabase, ctx.accountId);
    return NextResponse.json(directory);
  } catch (err) {
    return toErrorResponse(err);
  }
}
