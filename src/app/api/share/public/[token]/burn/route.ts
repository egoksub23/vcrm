// ============================================================
// POST /api/share/public/[token]/burn
//
// Revokes a share link after the first view (one-time view).
// Called by the URL viewer on mount. Idempotent — a second call
// against an already-revoked link is a no-op.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hashToken, isPlausibleToken } from "@/lib/share/tokens";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const ip = clientIp(request.headers);
  const rate = checkRateLimit(`share-burn:${ip}`, { limit: 60, windowMs: 60_000 });
  if (!rate.success) return rateLimitResponse(rate);

  const { token } = await params;
  if (!isPlausibleToken(token)) return new NextResponse(null, { status: 204 });

  const admin = supabaseAdmin();
  await admin
    .from("share_links")
    .update({ status: "revoked" })
    .eq("token_hash", hashToken(token))
    .eq("status", "active"); // only revoke if currently active — idempotent

  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
