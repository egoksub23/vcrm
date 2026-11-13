// POST /api/incidents/setup/webhooks/[id]/test — send a test ping to one webhook. Requires incidents.configure.
// Returns { ok, status_code } where status_code is the HTTP response code (or null on network error).
import { createHmac, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const db = createAdminPgDb();

    const { data } = await db
      .from("incident_school_webhooks")
      .select("id, url, signing_secret")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: "Webhook not found." }, { status: 404 });
    const row = data as { id: string; url: string; signing_secret: string };

    const deliveryId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: deliveryId, event: "ping", timestamp: new Date().toISOString(), test: true });
    const signature = `sha256=${createHmac("sha256", row.signing_secret).update(`${timestamp}.${body}`).digest("hex")}`;

    let statusCode: number | null = null;
    try {
      const res = await fetch(row.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Halo-Event": "ping",
          "X-Halo-Delivery": deliveryId,
          "X-Halo-Timestamp": String(timestamp),
          "X-Halo-Signature": signature,
          "User-Agent": "Halo-Webhook/1.0",
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      statusCode = res.status;
    } catch {
      statusCode = null;
    }

    await db
      .from("incident_school_webhooks")
      .update({ last_called_at: new Date().toISOString(), last_status_code: statusCode })
      .eq("id", id)
      .catch(() => {});

    return NextResponse.json({ ok: statusCode !== null && statusCode < 400, status_code: statusCode });
  } catch (err) {
    return toErrorResponse(err);
  }
}
