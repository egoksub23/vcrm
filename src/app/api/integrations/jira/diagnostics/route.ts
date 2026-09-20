// ============================================================
// /api/integrations/jira/diagnostics — the Diagnostics tab.
//
//   GET   recent sync events, queue counts and dead jobs, webhook health and
//         expiry, last catch-up, token expiry, the last rate-limit numbers
//   POST  { action: "register_webhooks" | "catchup_now" }
//
// Needs jira.connect. Read with the service role after the capability check;
// nothing returned contains a token or the webhook address.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { runCatchup } from "@/lib/jira/cron";
import { ensureWebhooks } from "@/lib/jira/connection";
import { ApiError, apiErrorResponse, jiraAppUrl, loadJiraContext } from "@/lib/jira/http";
import { cronDeps, jiraStore, readWebhookToken } from "@/lib/jira/service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await requireCapability("jira.connect");
    const db = supabaseAdmin();
    const store = jiraStore(db);
    const connection = await store.getConnectionByAccount(ctx.accountId);
    if (!connection) return NextResponse.json({ connection: null });

    const count = async (status: string) => {
      const { count: n } = await db
        .from("jira_sync_jobs")
        .select("id", { count: "exact", head: true })
        .eq("connection_id", connection.id)
        .eq("status", status);
      return n ?? 0;
    };
    const [events, deadJobs, pending, running, dead, links, lastHook] = await Promise.all([
      db
        .from("jira_sync_events")
        .select("id, level, kind, message, link_id, created_at")
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("jira_sync_jobs")
        .select("id, kind, attempts, last_error, finished_at")
        .eq("connection_id", connection.id)
        .eq("status", "dead")
        .order("finished_at", { ascending: false })
        .limit(10),
      count("pending"),
      count("running"),
      count("dead"),
      store.linksForConnection(connection.id),
      db.from("jira_webhook_events").select("received_at").eq("connection_id", connection.id).order("received_at", { ascending: false }).limit(1),
    ]);

    const ids = Array.isArray(connection.webhook_ids) ? connection.webhook_ids.length : 0;
    return NextResponse.json({
      connection: { status: connection.status, statusReason: connection.status_reason, siteName: connection.site_name },
      tokenExpiresAt: connection.token_expires_at,
      lastCatchupAt: connection.last_catchup_at,
      lastReportAt: connection.last_report_at,
      rateLimit: connection.rate_limit,
      webhook: {
        registered: ids > 0,
        count: ids,
        expiresAt: connection.webhook_expires_at,
        checkedAt: connection.webhook_checked_at,
        lastDeliveryAt: (lastHook.data as { received_at: string }[] | null)?.[0]?.received_at ?? null,
      },
      queue: { pending, running, dead },
      links: {
        ok: links.filter((l) => l.sync_state === "ok").length,
        paused: links.filter((l) => l.sync_state === "paused").length,
        broken: links.filter((l) => l.sync_state === "broken").length,
      },
      failures: (links ?? [])
        .filter((l) => l.sync_state !== "ok")
        .slice(0, 20)
        .map((l) => ({ linkId: l.id, key: l.issue_key, state: l.sync_state, error: l.sync_error })),
      events: events.data ?? [],
      deadJobs: deadJobs.data ?? [],
    });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const limit = checkRateLimit(`jira:diag:${ctx.userId}`, { limit: 6, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    const j = await loadJiraContext(ctx, request);

    if (body?.action === "register_webhooks") {
      const token = await readWebhookToken(j.db, j.connection.id);
      if (!token) throw new ApiError(409, "no_connection", "Jira is not connected");
      const report = await ensureWebhooks({ db: j.db, store: j.store, client: j.client, connection: j.connection, baseUrl: jiraAppUrl(request), webhookToken: token });
      return NextResponse.json({ webhooks: report });
    }
    if (body?.action === "catchup_now") {
      const deps = cronDeps(jiraAppUrl(request), j.db);
      // Forced: ignore the 5-minute spacing.
      const result = await runCatchup(deps, { ...j.connection, last_catchup_at: null });
      return NextResponse.json({ catchup: result });
    }
    throw new ApiError(400, "bad_request", "Unknown action");
  } catch (err) {
    return apiErrorResponse(err);
  }
}
