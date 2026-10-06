// ============================================================
// /r/[slug]: what the server knows about a registration page when it is drawn. Anyone can open this address, so
// it is rate limited per caller address like the signing page, and an address that is not a live registration page
// (unknown, switched off, or its workspace has Doc Sign off) is "invalid" without saying which. The page is drawn
// with a fresh signed form token, so it is never the same twice. Cached per request, so the page and its metadata
// share one lookup (and one token).
// ============================================================

import { cache } from "react";
import { headers } from "next/headers";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { turnstileSiteKey } from "@/lib/sign/registration/turnstile";
import { buildRegisterView, issuePageToken, loadPublicForm, type RegisterView } from "@/lib/sign/service/registration";
import { publicOrigin } from "@/lib/site-url";

export type RegisterLoad = { kind: "invalid" } | { kind: "busy" } | { kind: "unavailable" } | { kind: "ok"; view: RegisterView };

export const loadRegisterPage = cache(async (slug: string): Promise<RegisterLoad> => {
  const ip = clientIp(await headers());
  if (!checkRateLimit(`sign-register-page:${ip}`, { limit: 60, windowMs: 60_000 }).success) return { kind: "busy" };
  const found = await loadPublicForm(supabaseAdmin(), slug, publicOrigin());
  if (!found) return { kind: "invalid" };
  // no key to sign the page's token with: the page could not be submitted, so it does not pretend
  const token = issuePageToken(found.form);
  if (!token) return { kind: "unavailable" };
  return { kind: "ok", view: buildRegisterView(found, token, turnstileSiteKey()) };
});
