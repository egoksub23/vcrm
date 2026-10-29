// ============================================================
// /v/[token]: server-side load for a Secure Share link.
// Rate limited by IP; a link that is not active returns "invalid".
// Cached per request so the page and its metadata share one lookup.
// ============================================================

import { cache } from "react";
import { cookies, headers } from "next/headers";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { shareEnabled } from "@/lib/share/feature";
import { hashToken, isPlausibleToken, sessionCookieName, verifySession } from "@/lib/share/tokens";
import type { ShareGateType } from "@/lib/share/types";

export interface ShareLoadInfo {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  gateType: ShareGateType;
  downloadEnabled: boolean;
  /** True when the gate has been passed (or gate type is "none"). */
  gateCleared: boolean;
  kind: "file" | "url";
  redirectUrl: string | null;
  contentType: string;
  watermarkEnabled: boolean;
}

export type ShareLoad =
  | { kind: "invalid" }
  | { kind: "busy" }
  | { kind: "ok"; share: ShareLoadInfo };

export const loadShare = cache(async (token: string): Promise<ShareLoad> => {
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  if (!checkRateLimit(`share-public:${ip}`, { limit: 120, windowMs: 60_000 }).success) return { kind: "busy" };
  if (!isPlausibleToken(token)) return { kind: "invalid" };

  const admin = supabaseAdmin();
  const { data: share } = await admin
    .from("share_links")
    .select("id, account_id, title, file_name, file_size, gate_type, download_enabled, status, expires_at, kind, redirect_url, content_type, watermark_enabled")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (!share) return { kind: "invalid" };
  if (share.status !== "active") return { kind: "invalid" };
  if (share.expires_at && new Date(share.expires_at) <= new Date()) return { kind: "invalid" };
  if (!(await shareEnabled(admin, share.account_id))) return { kind: "invalid" };

  const gateType = share.gate_type as ShareGateType;
  let gateCleared = gateType === "none";

  if (!gateCleared) {
    const cookieStore = await cookies();
    const cookieVal = cookieStore.get(sessionCookieName(share.id))?.value ?? null;
    gateCleared = verifySession(decodeURIComponent(cookieVal ?? ""), share.id);
  }

  return {
    kind: "ok",
    share: {
      id: share.id,
      title: share.title,
      fileName: share.file_name,
      fileSize: share.file_size,
      gateType,
      downloadEnabled: share.download_enabled,
      gateCleared,
      kind: (share.kind ?? "file") as "file" | "url",
      redirectUrl: share.redirect_url ?? null,
      contentType: share.content_type ?? "application/pdf",
      watermarkEnabled: share.watermark_enabled ?? false,
    },
  };
});
