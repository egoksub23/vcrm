// ============================================================
// POST /api/share/public/[token]/ping
//
// Heartbeat from the viewer: reports the current page index and
// cumulative dwell times per page. Updates the most recent share_view
// row for this session (the row the file route inserted). Rate limited
// by IP.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hashToken, isPlausibleToken } from "@/lib/share/tokens";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const ip = clientIp(request.headers);
  const rate = checkRateLimit(`share-ping:${ip}`, { limit: 300, windowMs: 60_000 });
  if (!rate.success) return rateLimitResponse(rate);

  const { token } = await params;
  if (!isPlausibleToken(token)) return new NextResponse(null, { status: 204 });

  let body: { durationMs?: unknown; pageDwells?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // ignore malformed pings
  }

  const durationMs = typeof body.durationMs === "number" && body.durationMs >= 0 ? Math.round(body.durationMs) : null;
  const pageDwells =
    Array.isArray(body.pageDwells) && body.pageDwells.every((v) => typeof v === "number")
      ? (body.pageDwells as number[]).slice(0, 500)
      : null;

  if (durationMs === null && pageDwells === null) {
    return new NextResponse(null, { status: 204 });
  }

  const admin = supabaseAdmin();
  const { data: share } = await admin
    .from("share_links")
    .select("id, status")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (!share || share.status !== "active") return new NextResponse(null, { status: 204 });

  const ipVal = ip === "unknown" ? null : ip;

  // Update the most recent view from this IP (best effort — never fail a ping)
  try {
    const { data: view } = await admin
      .from("share_views")
      .select("id")
      .eq("share_id", share.id)
      .eq("ip", ipVal ?? "")
      .order("viewed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (view) {
      await admin
        .from("share_views")
        .update({
          ...(durationMs !== null ? { duration_ms: durationMs } : {}),
          ...(pageDwells !== null ? { page_dwells: pageDwells } : {}),
        })
        .eq("id", view.id);
    }
  } catch {
    // best effort
  }

  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
