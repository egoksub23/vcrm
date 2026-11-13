// POST /api/incidents/setup/test-notice — send a clearly marked test notice to the signed-in person's own email, so an admin can see exactly what a
// notice looks like and that email works for the school. Nothing is written to any incident. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createEmailAdapter } from "@/lib/incidents/platform/adapters";
import { buildNotice } from "@/lib/incidents/platform/messages";
import { checkRateLimit } from "@/lib/rate-limit";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function POST() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const limit = checkRateLimit(`incident-test-notice:${ctx.userId}`, { limit: 5, windowMs: 10 * 60_000 });
    if (!limit.success) return NextResponse.json({ error: "That is enough test notices for now. Try again in a few minutes." }, { status: 429 });

    const admin = createAdminPgDb();
    const { data: me } = await admin.from("profiles").select("email").eq("user_id", ctx.userId).maybeSingle();
    const email = (me as { email: string | null } | null)?.email;
    if (!email) return NextResponse.json({ error: "Your profile has no email address to send the test to." }, { status: 400 });

    const base = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
    if (!base) return NextResponse.json({ error: "The Halo address is not set on the server (NEXT_PUBLIC_SITE_URL), so notice links cannot be built." }, { status: 503 });

    const notice = buildNotice({
      reference: "INC-TEST-0",
      categoryName: "Example category",
      severityName: "Serious",
      reason: "test",
      incidentUrl: `${base}/incidents`,
      ackUrl: null,
      isTest: true,
    });
    const sent = await createEmailAdapter().send({ accountId: ctx.accountId, to: email, notice });
    if (!sent.ok) return NextResponse.json({ error: `The test notice could not be sent: ${sent.error}` }, { status: 502 });
    return NextResponse.json({ ok: true, to: email });
  } catch (err) {
    return toErrorResponse(err);
  }
}
