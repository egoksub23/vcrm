// POST /api/public/incident-intake/submit — file an incident directly without the browser form.
// Server to server: Authorization: Bearer ik_live_... (or ik_test_...) is the platform's key; X-Vircle-Group-Id names the school.
// Requires the "direct.submit" scope on the key.
//
// Body:
//   coach: { name, email?, phone? }
//   activity: { name, venue?, date? }
//   title: string
//   type: string          (category code from the school's template)
//   severity: string      (severity slug from the school's template)
//   flags?: string[]
//   description?: string
//   involved?: { student_id?, name, class? }[]
//   idempotency_key?: string   (same key+group → same reference, 24 hr window)
//
// Returns 201 { reference, mode, incident_id } on success, 200 { reference, duplicate: true } on duplicate.
import { NextResponse } from "next/server";

import { intakeDeps } from "@/lib/incidents/intake/runtime";
import { directSubmit } from "@/lib/incidents/intake/service";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const out = await directSubmit(intakeDeps(), {
      authorization: request.headers.get("authorization"),
      group: request.headers.get("x-vircle-group-id"),
      idempotencyKey: request.headers.get("idempotency-key"),
      body,
    });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[POST /api/public/incident-intake/submit]", err);
    return NextResponse.json({ error: { code: "server_error", message: "Something went wrong on our side. Try again in a moment." } }, { status: 500 });
  }
}
