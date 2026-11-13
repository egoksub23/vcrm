// /api/incidents/setup/webhooks — school-level webhook subscription management. Requires incidents.configure.
//   GET   list all subscriptions (signing_secret is NOT returned)
//   POST  { url, events, label? }  → { webhook: SchoolWebhookView, signing_secret: string }
//         The signing_secret is returned only on creation; store it now.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";
import { SCHOOL_WEBHOOK_EVENTS, createSchoolWebhook, listSchoolWebhooks, type SchoolWebhookEvent } from "@/lib/incidents/platform/school-webhooks";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const webhooks = await listSchoolWebhooks(createAdminPgDb(), ctx.accountId);
    return NextResponse.json({ webhooks });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return NextResponse.json({ error: "Provide a URL." }, { status: 400 });

    const rawEvents = Array.isArray(body.events) ? (body.events as unknown[]) : SCHOOL_WEBHOOK_EVENTS;
    const events = rawEvents.filter((e): e is SchoolWebhookEvent => typeof e === "string" && (SCHOOL_WEBHOOK_EVENTS as readonly string[]).includes(e));
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 100) : null;

    const result = await createSchoolWebhook(createAdminPgDb(), ctx.accountId, { url, events, label });
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ webhook: result.row, signing_secret: result.signing_secret }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
