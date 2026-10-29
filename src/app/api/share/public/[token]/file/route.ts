// ============================================================
// GET /api/share/public/[token]/file
//
// Stream the share's PDF to the viewer. Rate limited by IP.
// ?download=1 triggers a Content-Disposition: attachment header.
// Inserts a view row and increments view_count on every fetch (best
// effort: a tracking failure must not block file delivery).
// ============================================================

import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { isResendConfigured, sendEmail } from "@/lib/email/resend";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { shareEnabled } from "@/lib/share/feature";
import { getFile } from "@/lib/share/storage";
import { StorageError } from "@/lib/sign/storage";
import { hashToken, isPlausibleToken } from "@/lib/share/tokens";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  const rate = checkRateLimit(`share-file:${ip}`, { limit: 60, windowMs: 60_000 });
  if (!rate.success) return rateLimitResponse(rate);

  const { token } = await params;
  if (!isPlausibleToken(token)) return new NextResponse("Not found.", { status: 404 });

  const admin = supabaseAdmin();
  const { data: share } = await admin
    .from("share_links")
    .select("id, account_id, title, file_path, file_name, content_type, status, expires_at, download_enabled, first_opened_at, view_count, watermark_enabled")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (!share || share.status !== "active") return new NextResponse("Not found.", { status: 404 });
  if (share.expires_at && new Date(share.expires_at) <= new Date()) return new NextResponse("Not found.", { status: 404 });
  if (!(await shareEnabled(admin, share.account_id))) return new NextResponse("Not found.", { status: 404 });

  const url = new URL(request.url);
  const asDownload = url.searchParams.get("download") === "1";
  if (asDownload && !share.download_enabled) {
    return new NextResponse("Download is disabled for this share.", { status: 403 });
  }

  let bytes: Uint8Array;
  try {
    bytes = await getFile(admin, share.file_path, share.account_id);
  } catch (err) {
    if (err instanceof StorageError) return new NextResponse("File not found.", { status: 404 });
    throw err;
  }

  // PDF watermarking (Phase 4)
  if (
    (share as { watermark_enabled?: boolean }).watermark_enabled &&
    (share.content_type === "application/pdf" || share.content_type == null)
  ) {
    try {
      const { watermarkPdf } = await import("@/lib/share/watermark");
      const label = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo";
      bytes = await watermarkPdf(bytes, label);
    } catch {
      // watermarking failure must not block delivery
    }
  }

  // Record view: insert a row + increment counter + set first_opened_at (best effort)
  void (async () => {
    try {
      const userAgent = (requestHeaders.get("user-agent") ?? "").slice(0, 300) || null;
      const ipVal = ip === "unknown" ? null : ip;
      await admin.from("share_views").insert({ share_id: share.id, ip: ipVal, user_agent: userAgent });

      const isFirstOpen = !share.first_opened_at;
      await admin
        .from("share_links")
        .update({
          view_count: (share.view_count ?? 0) + 1,
          ...(isFirstOpen ? { first_opened_at: new Date().toISOString() } : {}),
        })
        .eq("id", share.id);

      if (isFirstOpen) {
        void notifyCreatorFirstOpen(share.id, share.title).catch(() => {});
      }
    } catch {
      // tracking failures must not block delivery
    }
  })();

  const contentDisposition = asDownload
    ? `attachment; filename="${share.file_name.replace(/"/g, "")}"`
    : `inline; filename="${share.file_name.replace(/"/g, "")}"`;

  return new NextResponse(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": share.content_type || "application/pdf",
      "Content-Disposition": contentDisposition,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}

async function notifyCreatorFirstOpen(shareId: string, shareTitle: string) {
  if (!isResendConfigured()) return;

  const admin = supabaseAdmin();
  const { data: link } = await admin
    .from("share_links")
    .select("created_by")
    .eq("id", shareId)
    .maybeSingle();

  if (!link?.created_by) return;

  const { data: userData } = await admin.auth.admin.getUserById(link.created_by);
  const creatorEmail = userData?.user?.email;
  if (!creatorEmail) return;

  const productName = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  await sendEmail({
    to: creatorEmail,
    subject: `"${shareTitle}" was just opened`,
    html: `<p>Someone just opened your shared document <strong>${esc(shareTitle)}</strong> for the first time.</p>
<p style="color:#666;font-size:12px">Sent via ${esc(productName)}</p>`,
    text: `Someone just opened your shared document "${shareTitle}" for the first time.`,
  });
}
