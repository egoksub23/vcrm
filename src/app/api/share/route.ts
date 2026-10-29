// ============================================================
// POST /api/share  — create a share link (share.send)
// GET  /api/share  — list share links for the workspace (member)
//
// Phase 4: accepts .docx (converted to HTML via mammoth), .html,
// and URL-redirect shares (JSON body, kind="url"). PDF shares gain
// an optional watermark_enabled flag.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { readBodyCapped } from "@/lib/net/read-capped";
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

    const ct = (request.headers.get("content-type") ?? "").toLowerCase();
    const isJson = ct.includes("application/json");

    // ── URL-redirect share (JSON body) ──────────────────────────
    if (isJson) {
      let body: Record<string, unknown>;
      try { body = await request.json(); } catch {
        return json({ error: "Could not read JSON body.", code: "bad_request" }, 400);
      }

      const redirectUrl = String(body.redirectUrl ?? "").trim();
      if (!redirectUrl) return json({ error: "redirectUrl is required.", code: "bad_request" }, 400);
      try { new URL(redirectUrl); } catch {
        return json({ error: "redirectUrl must be a valid URL.", code: "bad_request" }, 400);
      }

      const title = String(body.title ?? "").trim() || "Link";
      const contactId = String(body.contactId ?? "").trim() || null;
      const gateType = String(body.gateType ?? "none").trim();
      const downloadEnabled = body.downloadEnabled !== false;
      const expiresAtRaw = String(body.expiresAt ?? "").trim();
      const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null;
      const allowedEmails = parseAllowedEmails(body.allowedEmails);

      if (!["none", "email", "otp"].includes(gateType)) {
        return json({ error: "Invalid gate type.", code: "bad_request" }, 400);
      }

      const { data: issued, error: issueErr } = await admin.rpc("share_issue_token", {
        p_account_id: auth.accountId,
        p_created_by: auth.userId,
        p_title: title,
        p_file_path: null,
        p_file_name: "",
        p_file_size: 0,
        p_contact_id: contactId,
        p_gate_type: gateType,
        p_download_enabled: downloadEnabled,
        p_expires_at: expiresAt,
        p_allowed_emails: allowedEmails,
      });

      if (issueErr || !issued?.[0]) {
        return json({ error: "Could not create the share link.", code: "internal_error" }, 500);
      }

      const { id: shareId, token } = issued[0] as { id: string; token: string };
      await admin.from("share_links").update({ kind: "url", redirect_url: redirectUrl, file_path: null }).eq("id", shareId);

      const origin = publicOrigin() || new URL(request.url).origin;
      return json({ id: shareId, token, shareUrl: `${origin}/v/${token}` }, 201);
    }

    // ── File share (multipart) ───────────────────────────────────
    if (!ct.includes("multipart/form-data")) {
      return json({ error: "Multipart form data or JSON required.", code: "bad_request" }, 400);
    }

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES + 256 * 1024) {
      return json({ error: "File is too large. Maximum size is 25 MB.", code: "file_too_large" }, 413);
    }

    const raw = await readBodyCapped(request, MAX_FILE_BYTES + 256 * 1024);
    if (raw === null) {
      return json({ error: "File is too large. Maximum size is 25 MB.", code: "file_too_large" }, 413);
    }

    let formData: FormData;
    try {
      formData = await new Response(raw as unknown as BodyInit, {
        headers: { "content-type": ct },
      }).formData();
    } catch {
      return json({ error: "Could not read the form data.", code: "bad_request" }, 400);
    }

    const file = formData.get("file") as File | null;
    if (!file || !file.size) return json({ error: "Choose a file to upload.", code: "no_file" }, 400);

    const originalName = file.name || "document.pdf";
    const lowerName = originalName.toLowerCase();
    const isPdf = lowerName.endsWith(".pdf");
    const isDocx = lowerName.endsWith(".docx");
    const isHtml = lowerName.endsWith(".html") || lowerName.endsWith(".htm");

    if (!isPdf && !isDocx && !isHtml) {
      return json({ error: "Supported file types: PDF, DOCX, HTML.", code: "unsupported_type" }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return json({ error: "File is too large. Maximum size is 25 MB.", code: "file_too_large" }, 400);
    }

    const watermarkEnabled = isPdf && formData.get("watermarkEnabled") === "true";
    const baseTitle = originalName.replace(/\.(pdf|docx|html?)$/i, "");
    const title = String(formData.get("title") ?? "").trim() || baseTitle;
    const contactId = String(formData.get("contactId") ?? "").trim() || null;
    const gateType = String(formData.get("gateType") ?? "none").trim();
    const downloadEnabled = formData.get("downloadEnabled") !== "false";
    const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null;
    const allowedEmailsRaw = formData.get("allowedEmails");
    const allowedEmails = parseAllowedEmails(typeof allowedEmailsRaw === "string" ? allowedEmailsRaw.split(",") : null);

    if (!["none", "email", "otp"].includes(gateType)) {
      return json({ error: "Invalid gate type.", code: "bad_request" }, 400);
    }

    // Convert DOCX → HTML
    let storedBytes: Uint8Array;
    let storedMime: string;
    let storedName: string;

    if (isDocx) {
      const mammoth = await import("mammoth");
      const convert = mammoth.convertToHtml ?? (mammoth as unknown as { default: { convertToHtml: typeof mammoth.convertToHtml } }).default?.convertToHtml;
      const rawBytes = new Uint8Array(await file.arrayBuffer());
      const { value: html } = await convert({ buffer: Buffer.from(rawBytes) });
      storedBytes = new TextEncoder().encode(html);
      storedMime = "text/html";
      storedName = originalName.replace(/\.docx$/i, ".html");
    } else if (isHtml) {
      storedBytes = new Uint8Array(await file.arrayBuffer());
      storedMime = "text/html";
      storedName = originalName;
    } else {
      storedBytes = new Uint8Array(await file.arrayBuffer());
      storedMime = "application/pdf";
      storedName = originalName;
    }

    const safeName = safeFileName(storedName);

    const { data: issued, error: issueErr } = await admin.rpc("share_issue_token", {
      p_account_id: auth.accountId,
      p_created_by: auth.userId,
      p_title: title,
      p_file_path: "pending",
      p_file_name: safeName,
      p_file_size: storedBytes.byteLength,
      p_contact_id: contactId,
      p_gate_type: gateType,
      p_download_enabled: downloadEnabled,
      p_expires_at: expiresAt,
      p_allowed_emails: allowedEmails,
    });

    if (issueErr || !issued?.[0]) {
      return json({ error: "Could not create the share link.", code: "internal_error" }, 500);
    }

    const { id: shareId, token } = issued[0] as { id: string; token: string };
    const filePath = sharePath(auth.accountId, shareId, safeName);

    try {
      await putFile(admin, filePath, storedBytes, storedMime);
    } catch (err) {
      await admin.from("share_links").delete().eq("id", shareId);
      if (err instanceof StorageError) {
        return json({ error: "Could not store the file.", code: "storage_error" }, 500);
      }
      throw err;
    }

    await admin.from("share_links").update({
      file_path: filePath,
      content_type: storedMime,
      watermark_enabled: watermarkEnabled,
    }).eq("id", shareId);

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

const VALID_EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}$/;

function parseAllowedEmails(raw: unknown): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => VALID_EMAIL.test(e));
}
