// ============================================================
// /c/[slug]: what the server knows about a parent form when it is drawn. Anyone can open this address, so it is rate limited per caller address, and an
// address that is not a live form (unknown, switched off, or its workspace has Compliance off) is "invalid" without saying which. The page is drawn with
// a fresh signed form token, so it is never the same twice, and with whether the visitor already holds a session (they confirmed an address in the last
// hour). Cached per request, so the page and its metadata share one lookup (and one token).
// ============================================================

import { cache } from "react";
import { cookies, headers } from "next/headers";

import { buildPublicView, issuePageToken, loadPublicForm, type PublicView } from "@/lib/compliance/public/service";
import { publicFormsConfigured, readSession, sessionCookieName } from "@/lib/compliance/public/session";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { turnstileSiteKey } from "@/lib/sign/registration/turnstile";

export type PublicLoad = { kind: "invalid" } | { kind: "busy" } | { kind: "unavailable" } | { kind: "ok"; view: PublicView };

export const loadPublicPage = cache(async (slug: string): Promise<PublicLoad> => {
  const ip = clientIp(await headers());
  if (!checkRateLimit(`cmp-page:${ip}`, { limit: 60, windowMs: 60_000 }).success) return { kind: "busy" };
  const found = await loadPublicForm(supabaseAdmin(), slug);
  if (!found) return { kind: "invalid" };
  // no key to sign with: the form could not be submitted, so it does not pretend
  if (!publicFormsConfigured()) return { kind: "unavailable" };
  const token = issuePageToken(found.form);
  if (!token) return { kind: "unavailable" };
  const jar = await cookies();
  const session = readSession(jar.get(sessionCookieName(found.form.slug))?.value, found.form.id);
  return { kind: "ok", view: buildPublicView(found, token, turnstileSiteKey(), session.ok) };
});
