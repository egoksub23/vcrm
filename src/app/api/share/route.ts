// ============================================================
// POST /api/share  — create a share link (share.send)
// GET  /api/share  — list share links for the workspace (member)
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { publicOrigin } from "@/lib/site-url";
import { shareEnabled } from "@/lib/share/feature";
import { putFile, safeFileName, sharePath } from "@/lib/share/storage";
import { StorageError } from "@/lib/sign/storage";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  try {
    const auth = await requireCapability("share.send");
    const rate = checkRateLimit(`share-create:${auth.userId}`, { limit: 30, windowMs: 60_000 });
    if (!rate.success) return rateLimitResponse(rate);

    const admin = supabaseAdmin();
    if (!(await shareEnabled(admin, auth.accountId))) {
      return json({ error: "Secure Share is not enabled for this workspace.", code: "share_disabled" }, 403);
    }

    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "Multipart form data required.", code: "bad_request" }, 400);
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return json({ error: "Could not read the form data.", code: "bad_request" }, 400);
    }

    const file = formData.get("file") as File | null;
    if (!file || !file.size) return json({ error: "Choose a file to upload.", code: "no_file" }, 400);

    const fileName = file.name || "document.pdf";
    const lowerName = fileName.toLowerCase();
    if (!lowerName.endsWith(".pdf") && !lowerName.endsWith(".pptx")) {
      return json({ error: "Only PDF and PPTX files are supported.", code: "unsupported_type" }, 400);
    }
    if (lowerName.endsWith(".pptx")) {
      return json({ error: "PPTX support is coming soon. Please convert to PDF first.", code: "pptx_not_yet" }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return json({ error: "File is too large. Maximum size is 25 MB.", code: "file_too_large" }, 400);
    }

    const title = String(formData.get("title") ?? "").trim() || fileName.replace(/\.pdf$/i, "");
    const contactId = String(formData.get("contactId") ?? "").trim() || null;
    const gateType = String(formData.get("gateType") ?? "none").trim();
    const downloadEnabled = formData.get("downloadEnabled") !== "false";
    const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null;

    if (!["none", "email", "otp"].includes(gateType)) {
      return json({ error: "Invalid gate type.", code: "bad_request" }, 400);
    }

    // Issue the token first to get the share id
    const { data: issued, error: issueErr } = await admin.rpc("share_issue_token", {
      p_account_id: auth.accountId,
      p_created_by: auth.userId,
      p_title: title,
      p_file_path: "pending",
      p_file_name: safeFileName(fileName),
      p_file_size: file.size,
      p_contact_id: contactId,
      p_gate_type: gateType,
      p_download_enabled: downloadEnabled,
      p_expires_at: expiresAt,
    });

    if (issueErr || !issued?.[0]) {
      return json({ error: "Could not create the share link.", code: "internal_error" }, 500);
    }

    const { id: shareId, token } = issued[0] as { id: string; token: string };
    const safeName = safeFileName(fileName);
    const filePath = sharePath(auth.accountId, shareId, safeName);

    // Store the file
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await putFile(admin, filePath, bytes, "application/pdf");
    } catch (err) {
      // Clean up the DB row on storage failure
      await admin.from("share_links").delete().eq("id", shareId);
      if (err instanceof StorageError) {
        return json({ error: "Could not store the file.", code: "storage_error" }, 500);
      }
      throw err;
    }

    // Update the real file path
    await admin.from("share_links").update({ file_path: filePath }).eq("id", shareId);

    const origin = publicOrigin() || new URL(request.url).origin;
    return json({ id: shareId, token, shareUrl: `${origin}/v/${token}` }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    const auth = await requireCapability("share.send");
    const ip = clientIp(request.headers);
    const rate = checkRateLimit(`share-list:${ip}:${auth.accountId}`, { limit: 120, windowMs: 60_000 });
    if (!rate.success) return rateLimitResponse(rate);

    const url = new URL(request.url);
    const contactId = url.searchParams.get("contactId");

    const admin = supabaseAdmin();
    let q = admin
      .from("share_links")
      .select("id, title, file_name, file_size, status, gate_type, download_enabled, view_count, created_at, updated_at, first_opened_at, contact_id")
      .eq("account_id", auth.accountId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (contactId) q = q.eq("contact_id", contactId);

    const { data, error } = await q;
    if (error) return json({ error: "Could not load shares.", code: "internal_error" }, 500);

    const origin = publicOrigin() || new URL(request.url).origin;
    const shares = (data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      fileName: row.file_name,
      fileSize: row.file_size,
      status: row.status,
      gateType: row.gate_type,
      downloadEnabled: row.download_enabled,
      viewCount: row.view_count,
      firstOpenedAt: row.first_opened_at,
      contactId: row.contact_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return json({ shares, origin });
  } catch (err) {
    return toErrorResponse(err);
  }
}
