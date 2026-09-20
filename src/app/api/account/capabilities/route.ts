// ============================================================
// GET /api/account/capabilities
//
// The caller's role and effective capability set (role default plus
// the account's overrides for that role). Any member can call it: the
// client uses it to hide menus/buttons. It is a UI hint only — every
// route still enforces its own capability on the server.
// ============================================================

import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  loadCapabilities,
  toErrorResponse,
} from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const capabilities = await loadCapabilities(ctx);
    return NextResponse.json(
      { role: ctx.role, capabilities: [...capabilities].sort() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
