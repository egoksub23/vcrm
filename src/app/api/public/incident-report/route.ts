// POST /api/public/incident-report — the coach sends the report from the hosted page. { token, answers }. The link is the credential; no cookie.
import { NextResponse } from "next/server";

import { clientIp, intakeDeps } from "@/lib/incidents/intake/runtime";
import { submit } from "@/lib/incidents/intake/service";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    if (!checkRateLimit(`incident-report:${clientIp(request)}`, { limit: 40, windowMs: 60_000 }).success) {
      return NextResponse.json({ error: { code: "rate_limited", message: "Too many tries. Wait a minute and try again." } }, { status: 429 });
    }
    const body = (await request.json().catch(() => null)) as { token?: unknown; answers?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token.slice(0, 2000) : "";
    const out = await submit(intakeDeps(), { token, answers: body?.answers });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[POST /api/public/incident-report]", err);
    return NextResponse.json({ error: { code: "server_error", message: "We could not send the report. Your answers are kept on this phone; try again." } }, { status: 500 });
  }
}
