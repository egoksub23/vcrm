// ============================================================
// GET /api/share/public/[token]
//
// Returns the public share info the viewer needs to render the page:
// title, fileName, gateType, downloadEnabled. No secrets. Rate limited
// by IP. A token that is not live (unknown, revoked, expired) answers
// 404 and says nothing about whether a share link exists.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { shareEnabled } from "@/lib/share/feature";
import { hashToken, isPlausibleToken } from "@/lib/share/tokens";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

const NOT_FOUND = json({ error: "This link is not valid.", code: "link_not_found" }, 404);

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const ip = clientIp(request.headers);
  const rate = checkRateLimit(`share-public:${ip}`, { limit: 120, windowMs: 60_000 });
  if (!rate.success) return rateLimitResponse(rate);

  const { token } = await params;
  if (!isPlausibleToken(token)) return NOT_FOUND;

  const admin = supabaseAdmin();
  const { data: share } = await admin
    .from("share_links")
    .select("id, account_id, title, file_name, file_size, gate_type, download_enabled, status, expires_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (!share) return NOT_FOUND;
  if (share.status !== "active") return NOT_FOUND;
  if (share.expires_at && new Date(share.expires_at) <= new Date()) return NOT_FOUND;
  if (!(await shareEnabled(admin, share.account_id))) return NOT_FOUND;

  return json({
    id: share.id,
    title: share.title,
    fileName: share.file_name,
    fileSize: share.file_size,
    gateType: share.gate_type,
    downloadEnabled: share.download_enabled,
  });
}
