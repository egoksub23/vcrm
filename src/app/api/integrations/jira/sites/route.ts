// ============================================================
// /api/integrations/jira/sites — the site picker after a sign-in that
// reached more than one Jira site.
//
//   GET  ?pending=<id>              the sites the person can pick from
//   POST { pending, cloudId }       connect that site
//
// Needs jira.connect, and only the person who started the sign-in can
// finish it.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { completeConnection, ConnectError, ensureWebhooks } from "@/lib/jira/connection";
import { JiraClient } from "@/lib/jira/client";
import { ApiError, apiErrorResponse, jiraAppUrl } from "@/lib/jira/http";
import { isCloudId } from "@/lib/jira/oauth";
import { findPendingById, markPendingDone, readPendingTokens } from "@/lib/jira/pending";
import { clientForConnection, jiraStore, readWebhookToken } from "@/lib/jira/service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

async function loadPending(id: string | null, ctx: { userId: string; accountId: string }) {
  if (!id) throw new ApiError(400, "invalid_state", "Missing sign-in");
  const pending = await findPendingById(supabaseAdmin(), id);
  if (!pending || pending.status !== "awaiting_page_selection" || pending.account_id !== ctx.accountId || pending.initiated_by_user_id !== ctx.userId) {
    throw new ApiError(410, "invalid_state", "This sign-in expired. Start again.");
  }
  return pending;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const pending = await loadPending(new URL(request.url).searchParams.get("pending"), ctx);
    // Only what the picker needs; never a token.
    return NextResponse.json({ sites: pending.sites.map((s) => ({ id: s.id, name: s.name, url: s.url })) });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const limit = checkRateLimit(`jira:sites:${ctx.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => ({}))) as { pending?: unknown; cloudId?: unknown };
    const pending = await loadPending(typeof body.pending === "string" ? body.pending : null, ctx);
    if (!isCloudId(body.cloudId)) throw new ApiError(400, "invalid_site", "Pick one of the listed sites");
    const site = pending.sites.find((s) => s.id === (body.cloudId as string).toLowerCase());
    if (!site) throw new ApiError(400, "invalid_site", "Pick one of the listed sites");

    const db = supabaseAdmin();
    const tokens = await readPendingTokens(db, pending.id);
    if (!tokens) throw new ApiError(410, "invalid_state", "This sign-in expired. Start again.");

    const store = jiraStore(db);
    const probe = new JiraClient({ cloudId: site.id, getAccessToken: async () => tokens.accessToken, connectionKey: `probe:${pending.id}` });
    const myself = await probe.getMyself().catch(() => null);
    try {
      const { connection } = await completeConnection({ db, store, accountId: ctx.accountId, userId: ctx.userId, site, tokens, myself });
      await markPendingDone(db, pending.id, "completed");
      const base = jiraAppUrl(request);
      const token = await readWebhookToken(db, connection.id);
      if (token) {
        await ensureWebhooks({ db, store, client: clientForConnection(db, connection, { store }), connection, baseUrl: base, webhookToken: token }).catch(() => undefined);
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof ConnectError) throw new ApiError(409, err.code, err.message);
      throw err;
    }
  } catch (err) {
    return apiErrorResponse(err);
  }
}
