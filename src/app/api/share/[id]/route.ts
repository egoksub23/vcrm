// ============================================================
// GET   /api/share/[id] — get a share link + its recent views (share.send)
// PATCH /api/share/[id] — revoke or toggle download (share.send)
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { publicOrigin } from "@/lib/site-url";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireCapability("share.send");
    const { id } = await params;
    if (!UUID_RE.test(id)) return json({ error: "Not found.", code: "not_found" }, 404);

    const rate = checkRateLimit(`share-get:${auth.userId}`, { limit: 120, windowMs: 60_000 });
    if (!rate.success) return rateLimitResponse(rate);

    const admin = supabaseAdmin();
    const { data: share, error } = await admin
      .from("share_links")
      .select("*")
      .eq("id", id)
      .eq("account_id", auth.accountId)
      .maybeSingle();

    if (error || !share) return json({ error: "Not found.", code: "not_found" }, 404);

    const { data: views } = await admin
      .from("share_views")
      .select("id, viewer_email, ip, viewed_at, duration_ms, page_dwells")
      .eq("share_id", id)
      .order("viewed_at", { ascending: false })
      .limit(50);

    const origin = publicOrigin() || new URL(request.url).origin;
    return json({
      share: {
        id: share.id,
        title: share.title,
        fileName: share.file_name,
        fileSize: share.file_size,
        contentType: share.content_type,
        status: share.status,
        gateType: share.gate_type,
        downloadEnabled: share.download_enabled,
        viewCount: share.view_count,
        firstOpenedAt: share.first_opened_at,
        expiresAt: share.expires_at,
        contactId: share.contact_id,
        createdAt: share.created_at,
        updatedAt: share.updated_at,
        shareUrl: `${origin}/v/${share.token}`,
      },
      views: (views ?? []).map((v: { id: string; viewer_email: string | null; viewed_at: string; duration_ms: number | null; page_dwells: number[] | null }) => ({
        id: v.id,
        viewerEmail: v.viewer_email,
        viewedAt: v.viewed_at,
        durationMs: v.duration_ms,
        pageDwells: v.page_dwells,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireCapability("share.send");
    const { id } = await params;
    if (!UUID_RE.test(id)) return json({ error: "Not found.", code: "not_found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON.", code: "bad_request" }, 400);
    }

    const admin = supabaseAdmin();
    const updates: Record<string, unknown> = {};
    if (body.status === "revoked") updates.status = "revoked";
    if (typeof body.downloadEnabled === "boolean") updates.download_enabled = body.downloadEnabled;
    if (typeof body.title === "string" && body.title.trim()) updates.title = body.title.trim();

    if (Object.keys(updates).length === 0) {
      return json({ error: "No valid fields to update.", code: "bad_request" }, 400);
    }

    const { error } = await admin
      .from("share_links")
      .update(updates)
      .eq("id", id)
      .eq("account_id", auth.accountId);

    if (error) return json({ error: "Could not update the share.", code: "internal_error" }, 500);

    return json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
