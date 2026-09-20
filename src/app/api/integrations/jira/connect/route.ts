// ============================================================
// GET /api/integrations/jira/connect
//
// Settings > Integrations > Jira > Connect (or Reconnect). Needs
// jira.connect. Creates a one-time pending sign-in with a signed state bound
// to this person and workspace, then sends the browser to Atlassian's
// consent screen (a full-page redirect, like every other channel).
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { apiErrorResponse, ApiError, jiraAppUrl } from "@/lib/jira/http";
import { buildAuthorizeUrl, createOAuthState, isJiraConfigured, readOAuthConfig, redirectUri, stateSecret } from "@/lib/jira/oauth";
import { createPending } from "@/lib/jira/pending";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const limit = checkRateLimit(`jira:connect:${ctx.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    if (!isJiraConfigured()) throw new ApiError(503, "jira_not_configured", "Jira is not configured on this server");

    const { state } = createOAuthState({ accountId: ctx.accountId, userId: ctx.userId }, stateSecret());
    await createPending(supabaseAdmin(), { accountId: ctx.accountId, userId: ctx.userId, state });

    const url = buildAuthorizeUrl({
      clientId: readOAuthConfig().clientId,
      redirectUri: redirectUri(jiraAppUrl(request)),
      state,
    });
    return NextResponse.redirect(url);
  } catch (err) {
    return apiErrorResponse(err);
  }
}
