// /api/incidents/setup/webhooks/[id] — manage one webhook subscription. Requires incidents.configure.
//   PATCH  { url?, events?, label?, enabled? }
//   DELETE remove the subscription
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";
import { SCHOOL_WEBHOOK_EVENTS, deleteSchoolWebhook, updateSchoolWebhook, type SchoolWebhookEvent } from "@/lib/incidents/platform/school-webhooks";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

    const patch: { url?: string; events?: SchoolWebhookEvent[]; label?: string | null; enabled?: boolean } = {};
    if (typeof body.url === "string") patch.url = body.url.trim();
    if (Array.isArray(body.events)) {
      patch.events = (body.events as unknown[]).filter((e): e is SchoolWebhookEvent => typeof e === "string" && (SCHOOL_WEBHOOK_EVENTS as readonly string[]).includes(e));
    }
    if (body.label !== undefined) patch.label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 100) : null;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

    const result = await updateSchoolWebhook(createAdminPgDb(), ctx.accountId, id, patch);
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ webhook: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const ok = await deleteSchoolWebhook(createAdminPgDb(), ctx.accountId, id);
    if (!ok) return NextResponse.json({ error: "Could not delete the webhook." }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
