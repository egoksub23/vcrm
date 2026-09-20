// ============================================================
// /api/integrations/jira/connection — the workspace's Jira connection.
//
//   GET     the safe view: configured?, the connection row (no secret exists
//           in it), the validated settings, the callback address and counts
//   PATCH   { settings: { ...partial } }   validated, audited (section names
//           only, never values)
//   DELETE  ?purge=1  disconnect: tokens deleted, webhooks removed, links
//           paused (or removed with purge)
//
// All need jira.connect. The token columns live in another table this route
// never reads.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientForConnection, jiraStore } from "@/lib/jira/service";
import { disconnect } from "@/lib/jira/connection";
import { ApiError, apiErrorResponse, jiraAppUrl } from "@/lib/jira/http";
import { isJiraConfigured, redirectUri } from "@/lib/jira/oauth";
import { computeChecklist } from "@/lib/jira/checklist";
import { applySettingsPatch, changedSections, normalizeSettings } from "@/lib/jira/settings";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const store = jiraStore();
    const connection = await store.getConnectionByAccount(ctx.accountId);
    const base = jiraAppUrl(request);

    let counts = { links: 0, paused: 0, broken: 0 };
    if (connection) {
      const links = await store.linksForConnection(connection.id);
      counts = {
        links: links.length,
        paused: links.filter((l) => l.sync_state === "paused").length,
        broken: links.filter((l) => l.sync_state === "broken").length,
      };
    }
    const configured = isJiraConfigured();
    const settings = normalizeSettings(connection?.settings);

    // The first-run checklist: has a webhook arrived, or a queued sync finished?
    let syncEvidence = false;
    if (connection && connection.status === "active") {
      const db = supabaseAdmin();
      const [hooks, jobs] = await Promise.all([
        db.from("jira_webhook_events").select("id", { count: "exact", head: true }).eq("connection_id", connection.id),
        db.from("jira_sync_jobs").select("id", { count: "exact", head: true }).eq("connection_id", connection.id).eq("kind", "sync_issue").eq("status", "done"),
      ]);
      syncEvidence = (hooks.count ?? 0) > 0 || (jobs.count ?? 0) > 0;
    }
    return NextResponse.json({
      configured,
      callbackUrl: redirectUri(base),
      connection,
      settings,
      counts,
      checklist: computeChecklist({ configured, connection, settings, syncEvidence }),
    });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const limit = checkRateLimit(`jira:settings:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { settings?: unknown } | null;
    if (!body || typeof body.settings !== "object" || body.settings === null) {
      throw new ApiError(400, "bad_request", "Send { settings: { ... } }");
    }
    const store = jiraStore();
    const connection = await store.getConnectionByAccount(ctx.accountId);
    if (!connection || connection.status === "revoked") throw new ApiError(409, "no_connection", "Jira is not connected");

    const before = normalizeSettings(connection.settings);
    const after = applySettingsPatch(before, body.settings);
    const changed = changedSections(before, after);
    if (changed.length > 0) {
      await store.updateConnection(connection.id, { settings: after });
      await store.audit({
        accountId: ctx.accountId,
        actorId: ctx.userId,
        action: "updated",
        entityType: "jira_connection",
        entityId: connection.id,
        label: connection.site_name ?? "Jira",
        // Names only: which parts of the configuration changed.
        summary: { changed },
      });
    }
    return NextResponse.json({ settings: after, changed });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const limit = checkRateLimit(`jira:disconnect:${ctx.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const purge = new URL(request.url).searchParams.get("purge") === "1";
    const db = supabaseAdmin();
    const store = jiraStore(db);
    const connection = await store.getConnectionByAccount(ctx.accountId);
    if (!connection) throw new ApiError(404, "no_connection", "Jira is not connected");

    // Deregister the webhooks first (needs the tokens), best effort.
    let client = null;
    if (connection.status === "active" && isJiraConfigured()) {
      try {
        client = clientForConnection(db, connection, { store });
      } catch {
        client = null;
      }
    }
    const result = await disconnect({ db, store, client, connection, userId: ctx.userId, purge });
    return NextResponse.json({ ok: true, purged: purge, ...result });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
