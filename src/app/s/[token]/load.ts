// ============================================================
// /s/[token]: what the server knows about a link when the page is drawn, so the first paint already has
// the document's state and the right language. It does what the API does for a signer
// (src/lib/sign/http.ts `publicLink` and GET /api/sign/public/[token]): the same rate limit per caller
// address, the same lookup by the token's hash, the same check that the workspace has Doc Sign on, the
// same session cookie check, the same "viewed" record, the same view. A link that is not live says
// nothing about whether a document exists.
//
// Cached per request, so the page and its metadata share one lookup.
// ============================================================

import { cache } from "react";
import { cookies, headers } from "next/headers";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { signEnabled } from "@/lib/sign/feature";
import { realDeps } from "@/lib/sign/notify";
import { buildView, codeRequiredFor, lookupByToken, markViewed, pageState, pickDocument, signerCtx, type SigningView } from "@/lib/sign/service/signing";
import { isPlausibleToken, sessionCookieName, verifySession } from "@/lib/sign/tokens";
import { publicOrigin } from "@/lib/site-url";

export type SigningLoad =
  | { kind: "invalid" }
  | { kind: "busy" }
  | { kind: "ok"; view: SigningView; sessionOk: boolean };

export const loadSigning = cache(async (token: string): Promise<SigningLoad> => {
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  if (!checkRateLimit(`sign-public:${ip}`, { limit: 120, windowMs: 60_000 }).success) return { kind: "busy" };
  if (!isPlausibleToken(token)) return { kind: "invalid" };

  const admin = supabaseAdmin();
  const lookup = await lookupByToken(admin, token);
  // A workspace whose Doc Sign is switched off (or that is suspended) shows no document at all.
  if (!lookup || !(await signEnabled(admin, lookup.signer.account_id))) return { kind: "invalid" };

  const ctx = signerCtx({ admin, origin: publicOrigin(), deps: realDeps, now: () => new Date() }, lookup);
  const jar = await cookies();
  // one code for the link, whichever document of an envelope is asked for (the cookie belongs to the link's own row)
  const sessionOk = !codeRequiredFor(lookup) || verifySession(jar.get(sessionCookieName(lookup.tokenSigner.id))?.value, lookup.tokenSigner.id);
  const needsCode = codeRequiredFor(lookup) && !sessionOk;
  if (!needsCode && (lookup.party ? lookup.party.members.some((m) => pageState(m.doc, m.signer) === "active") : pageState(lookup.doc, lookup.signer) === "active")) {
    await markViewed(ctx, lookup, ip === "unknown" ? null : ip, (requestHeaders.get("user-agent") ?? "").slice(0, 300) || null);
  }
  // an envelope opens on the first document still to do (or the first, when there is none): the person's sitting resumes where it stopped
  const focus = lookup.party ? (lookup.party.members.find((m) => pageState(m.doc, m.signer) === "active") ?? lookup.party.members[0]) : null;
  const shown = (focus && pickDocument(lookup, focus.doc.id)) || lookup;
  return { kind: "ok", view: await buildView(ctx, shown, sessionOk), sessionOk };
});
