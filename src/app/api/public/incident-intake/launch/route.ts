// POST /api/public/incident-intake/launch — the coach portal asks for a one-time report link.
// Server to server, Authorization: Bearer ik_live_... (or ik_test_...). The school comes from the key. See docs/incident-coach-portal.md.
import { NextResponse } from "next/server";

import { intakeDeps } from "@/lib/incidents/intake/runtime";
import { launch } from "@/lib/incidents/intake/service";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const out = await launch(intakeDeps(), {
      authorization: request.headers.get("authorization"),
      idempotencyKey: request.headers.get("idempotency-key"),
      body,
    });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[POST /api/public/incident-intake/launch]", err);
    return NextResponse.json({ error: { code: "server_error", message: "Something went wrong on our side. Try again in a moment." } }, { status: 500 });
  }
}
