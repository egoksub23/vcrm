// POST /api/public/incident-ack — { token }. The one-tap "I have seen this" from a notice email. No login: the signed token names one message.
// The reply never says why a token failed, so it cannot be used to probe for valid ones.
import { NextResponse } from "next/server";

import { acknowledgeByToken } from "@/lib/incidents/platform/ack";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`incident-ack:${ip}`, { limit: 30, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "Too many tries. Wait a minute and try again." }, { status: 429 });

  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.slice(0, 200) : "";
  const ok = token ? await acknowledgeByToken(token) : false;
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "This link is not valid." }, { status: 404 });
}
