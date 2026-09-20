// ============================================================
// GET /api/integrations/jira/callback
//
// Atlassian redirects here with ?code=&state=. This exact path is what the
// Vircle app registers in the Atlassian console (docs/jira-setup.md).
//
// The state is the auth: it must carry our signature, not be expired, match
// a live one-time pending row, and belong to the person who is signed in to
// Vircle right now. The pending row is consumed in ONE conditional update, so
// a replayed callback finds nothing. Then: exchange the code, list the
// sites; one site is connected straight away, several go to the picker.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { ensureWebhooks, completeConnection, ConnectError } from "@/lib/jira/connection";
import { JiraClient } from "@/lib/jira/client";
import { describeError } from "@/lib/jira/errors";
import { jiraAppUrl } from "@/lib/jira/http";
import {
  exchangeCodeForTokens,
  fetchAccessibleResources,
  readOAuthConfig,
  redirectUri,
  stateSecret,
  verifyOAuthState,
} from "@/lib/jira/oauth";
import { consumePending, findPendingByState, markPendingDone, storeForPicker } from "@/lib/jira/pending";
import { clientForConnection, jiraStore, readWebhookToken } from "@/lib/jira/service";

function back(base: string, params: Record<string, string>): NextResponse {
  const url = new URL("/settings", base || "http://localhost");
  url.searchParams.set("tab", "integrations");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const base = jiraAppUrl(request);
  const q = new URL(request.url).searchParams;
  const code = q.get("code");
  const state = q.get("state");
  const oauthError = q.get("error");

  if (oauthError) {
    // access_denied: the person said no. Anything else Atlassian sent is shown as a generic failure.
    return back(base, { jira: "error", reason: oauthError === "access_denied" ? "denied" : "atlassian" });
  }
  if (!code || !state) return back(base, { jira: "error", reason: "invalid_state" });

  const db = supabaseAdmin();
  let pendingId: string | null = null;
  try {
    // 1. Signature, expiry, one-time row.
    const payload = verifyOAuthState(state, stateSecret());
    if (!payload) return back(base, { jira: "error", reason: "invalid_state" });
    const pending = await findPendingByState(db, state);
    if (!pending || pending.status !== "pending" || pending.account_id !== payload.a || pending.initiated_by_user_id !== payload.u) {
      return back(base, { jira: "error", reason: "invalid_state" });
    }

    // 2. The person who started it is the person finishing it, and may still connect.
    const ctx = await requireCapability("jira.connect");
    if (ctx.userId !== payload.u || ctx.accountId !== payload.a) return back(base, { jira: "error", reason: "invalid_state" });

    // 3. Single use.
    if (!(await consumePending(db, pending.id))) return back(base, { jira: "error", reason: "invalid_state" });
    pendingId = pending.id;

    // 4. Code -> tokens -> sites.
    const config = readOAuthConfig();
    const tokens = await exchangeCodeForTokens({ code, redirectUri: redirectUri(base), config });
    const sites = await fetchAccessibleResources(tokens.accessToken);
    if (sites.length === 0) {
      await markPendingDone(db, pending.id, "failed");
      return back(base, { jira: "error", reason: "no_sites" });
    }
    if (sites.length > 1) {
      await storeForPicker(db, pending.id, tokens, sites);
      return back(base, { jira: "pick", pending: pending.id });
    }

    // 5. One site: connect now.
    const site = sites[0];
    const store = jiraStore(db);
    const probe = new JiraClient({ cloudId: site.id, getAccessToken: async () => tokens.accessToken, connectionKey: `probe:${pending.id}` });
    const myself = await probe.getMyself().catch(() => null);
    const { connection } = await completeConnection({ db, store, accountId: ctx.accountId, userId: ctx.userId, site, tokens, myself });
    await markPendingDone(db, pending.id, "completed");
    await bestEffortWebhooks(db, connection.id, base);
    return back(base, { jira: "connected" });
  } catch (err) {
    console.error("[jira callback] failed:", describeError(err));
    if (pendingId) await markPendingDone(db, pendingId, "failed").catch(() => undefined);
    const reason = err instanceof ConnectError ? err.code : (err as { status?: number })?.status === 403 ? "forbidden" : "unknown";
    return back(base, { jira: "error", reason });
  }
}

/** Register the webhooks once the connection exists; a failure is left to the daily job and the catch-up. */
async function bestEffortWebhooks(db: ReturnType<typeof supabaseAdmin>, connectionId: string, base: string): Promise<void> {
  try {
    const store = jiraStore(db);
    const connection = await store.getConnection(connectionId);
    const token = await readWebhookToken(db, connectionId);
    if (!connection || !token) return;
    await ensureWebhooks({ db, store, client: clientForConnection(db, connection, { store }), connection, baseUrl: base, webhookToken: token });
  } catch (e) {
    console.error("[jira callback] webhook registration skipped:", describeError(e));
  }
}
