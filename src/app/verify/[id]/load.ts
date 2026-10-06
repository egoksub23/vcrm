// ============================================================
// /verify/[id]: what the server knows about a signed document when the page is drawn. Anyone can open
// this address (it is the QR code on a certificate), so it is rate limited per caller address like the
// signing page, and an address that is not a signed document, or whose workspace has Doc Sign off, is
// "invalid" without saying which. Cached per request, so the page and its metadata share one lookup.
// ============================================================

import { cache } from "react";
import { headers } from "next/headers";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { isDocumentId, loadVerification, type VerifyView } from "@/lib/sign/service/verify";

export type VerifyLoad = { kind: "invalid" } | { kind: "busy" } | { kind: "ok"; view: VerifyView };

export const loadVerifyPage = cache(async (id: string): Promise<VerifyLoad> => {
  const ip = clientIp(await headers());
  if (!checkRateLimit(`sign-verify:${ip}`, { limit: 60, windowMs: 60_000 }).success) return { kind: "busy" };
  if (!isDocumentId(id)) return { kind: "invalid" };
  const view = await loadVerification(supabaseAdmin(), id);
  return view ? { kind: "ok", view } : { kind: "invalid" };
});
