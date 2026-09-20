// ============================================================
// The scheduled work behind GET /api/integrations/jira/cron.
//
// One call does, in this order and inside a time budget:
//   1. jobs      claim due jobs (FOR UPDATE SKIP LOCKED in SQL), run them,
//                retry with backoff, dead-letter after the attempts run out
//   2. catch-up  about every 5 minutes, per connection with live links: ONE
//                JQL search for linked issues changed recently + one bulk
//                read, applied like a webhook would have been
//   3. daily     renew / re-register the webhooks (they expire after 30
//                days), keep the refresh token alive, match new members to
//                Jira users, prune old rows
//   4. weekly    Atlassian's personal-data report
// Nothing here needs Vercel-style long runs: the VPS crontab calls it every
// minute or two and each step is idempotent and bounded.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { pullAttachments, sendTicketAttachment } from "./attachments";
import {
  buildCatchupJql,
  catchupStall,
  catchupWindowMinutes,
  chunkIds,
  classifyJobError,
  retryDelaySeconds,
} from "./catchup";
import { processBulkItem } from "./bulk";
import { pushFieldChanges } from "./fields-sync";
import type { JiraClient } from "./client";
import { ensureWebhooks, webhookRenewalDue } from "./connection";
import { describeError, JiraAuthError, JiraRateLimitError } from "./errors";
import { normalizeSettings } from "./settings";
import type { JiraStore, JobRow } from "./store";
import { applyIssueToLinks, editSharedNote, issueFieldList, pushStatus, shareNoteToJira, syncIssue, type SyncContext } from "./sync";
import { autoMatchMembers } from "./users";
import type { JiraConnectionRow, ReportResult, TicketStatusValue } from "./types";

/** Minimum time between catch-ups of one connection. */
export const CATCHUP_INTERVAL_MS = 5 * 60_000;
export const REPORT_INTERVAL_MS = 7 * 86_400_000 - 3_600_000;

export interface CronContext extends SyncContext {
  /** The full client (webhooks, users, report), not just the sync subset. */
  client: JiraClient;
}

export interface CronDeps {
  db: SupabaseClient;
  store: JiraStore;
  /** Build a ready client + context for a connection (tokens, refresh, rate-limit logging). */
  contextFor: (connection: JiraConnectionRow) => CronContext;
  baseUrl: string;
  readWebhookToken: (connectionId: string) => Promise<string | null>;
  now?: () => number;
  worker?: string;
  /** Wall-clock budget for one call (default 50 s). */
  budgetMs?: number;
}

export interface CronReport {
  jobs: { claimed: number; done: number; retried: number; dead: number };
  catchup: { connections: number; issues: number; failed: number; stalled: number };
  daily: { connections: number; webhooks: string[]; matched: number };
  weekly: { reported: number; failed: number };
  pruned: number;
  ms: number;
}

// ------------------------------------------------------------
// 1. Jobs
// ------------------------------------------------------------

export async function processJob(ctx: CronContext, job: Pick<JobRow, "kind" | "payload">): Promise<void> {
  const p = job.payload ?? {};
  switch (job.kind) {
    case "sync_issue": {
      const issueId = typeof p.issue_id === "string" ? p.issue_id : null;
      if (issueId) await syncIssue(ctx, issueId, { comments: p.comments !== false, source: "job" });
      return;
    }
    case "push_status": {
      if (typeof p.ticket_id === "string" && typeof p.status === "string") {
        await pushStatus(ctx, { ticketId: p.ticket_id, status: p.status as TicketStatusValue });
      }
      return;
    }
    case "post_comment": {
      if (typeof p.note_id === "string") {
        await shareNoteToJira(ctx, {
          noteId: p.note_id,
          actorUserId: typeof p.actor === "string" ? p.actor : null,
          linkId: typeof p.link_id === "string" ? p.link_id : undefined,
        });
      }
      return;
    }
    case "edit_comment": {
      if (typeof p.ticket_comment_id === "string") await editSharedNote(ctx, p.ticket_comment_id);
      return;
    }
    case "push_fields": {
      if (typeof p.ticket_id === "string") await pushFieldChanges(ctx, { ticketId: p.ticket_id });
      return;
    }
    case "push_attachment": {
      if (typeof p.attachment_id !== "string") return;
      if (!ctx.storage) throw new Error("attachments need the storage client");
      const results = await sendTicketAttachment(
        { store: ctx.store, client: ctx.client, storage: ctx.storage, connection: ctx.connection, settings: ctx.settings, now: ctx.now },
        { attachmentId: p.attachment_id, linkId: typeof p.link_id === "string" ? p.link_id : undefined, auto: p.auto === true },
      );
      // What the queue must not retry (a file that is too big, a switched-off project) is recorded, not thrown.
      for (const r of results.filter((x) => !x.ok)) {
        await ctx.store.logEvent({
          accountId: ctx.connection.account_id,
          connectionId: ctx.connection.id,
          linkId: r.linkId || null,
          level: "info",
          kind: "attachment_not_sent",
          message: `${r.key || "attachment"}: ${r.code}`,
        });
      }
      return;
    }
    case "pull_attachments": {
      if (typeof p.link_id !== "string") return;
      if (!ctx.storage) throw new Error("attachments need the storage client");
      const link = await ctx.store.getLink(p.link_id);
      if (!link || link.sync_state === "paused") return;
      const issue = await ctx.client.getIssue(link.issue_id, await issueFieldList(ctx));
      if (!issue) return;
      const r = await pullAttachments(
        { store: ctx.store, client: ctx.client, storage: ctx.storage, connection: ctx.connection, settings: ctx.settings, now: ctx.now },
        link,
        issue,
      );
      // More new files than one run takes: a follow-up job continues.
      if (r.more) {
        await ctx.store.enqueue({
          accountId: link.account_id,
          connectionId: ctx.connection.id,
          kind: "pull_attachments",
          payload: { link_id: link.id },
          dedupeKey: `pullatt:${link.id}`,
          delaySeconds: 5,
        });
      }
      return;
    }
    case "bulk_item": {
      if (typeof p.batch_id === "string" && typeof p.item_id === "string") {
        await processBulkItem(ctx, { batchId: p.batch_id, itemId: p.item_id, userId: typeof p.user_id === "string" ? p.user_id : null });
      }
      return;
    }
  }
}

export async function runJobs(deps: CronDeps, deadline: number): Promise<CronReport["jobs"]> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const worker = deps.worker ?? `cron-${now().toString(36)}`;
  const out = { claimed: 0, done: 0, retried: 0, dead: 0 };
  const connections = new Map<string, JiraConnectionRow | null>();

  while (now() < deadline) {
    const jobs = await store.claimJobs(10, worker, 120);
    if (jobs.length === 0) break;
    out.claimed += jobs.length;

    for (const job of jobs) {
      let conn = connections.get(job.connection_id);
      if (conn === undefined) {
        conn = await store.getConnection(job.connection_id);
        connections.set(job.connection_id, conn);
      }
      if (!conn) {
        await store.finishJob(job.id, worker, "dead", "connection is gone", 0);
        out.dead += 1;
        continue;
      }
      if (conn.status !== "active") {
        // Waiting for a reconnect: try again later; the queue dead-letters it eventually.
        const r = await store.finishJob(job.id, worker, "retry", `connection ${conn.status}`, 900);
        if (r === "dead") out.dead += 1;
        else out.retried += 1;
        continue;
      }
      try {
        await processJob(deps.contextFor(conn), job);
        await store.finishJob(job.id, worker, "ok", null, 0);
        out.done += 1;
      } catch (err) {
        const cls =
          err instanceof JiraAuthError
            ? ({ outcome: "retry", seconds: 900 } as const)
            : classifyJobError(err, job.attempts);
        const r = await store.finishJob(
          job.id,
          worker,
          cls.outcome,
          describeError(err),
          cls.outcome === "retry" ? cls.seconds : 0,
        );
        await store.logEvent({
          accountId: job.account_id,
          connectionId: job.connection_id,
          level: r === "dead" ? "error" : "warn",
          kind: r === "dead" ? "job_dead" : "job_retry",
          message: `${job.kind}: ${describeError(err)}`,
          details: { attempts: job.attempts, outcome: r },
        });
        if (r === "dead") out.dead += 1;
        else out.retried += 1;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// 2. Catch-up
// ------------------------------------------------------------

/** Re-read the linked issues that changed recently; the safety net for missed webhooks. */
export async function runCatchup(
  deps: CronDeps,
  connection: JiraConnectionRow,
): Promise<{ ran: boolean; issues: number }> {
  const { store } = deps;
  const now = (deps.now ?? Date.now)();
  const last = connection.last_catchup_at ? new Date(connection.last_catchup_at) : null;
  if (last && now - last.getTime() < CATCHUP_INTERVAL_MS) return { ran: false, issues: 0 };

  const links = await store.linksForConnection(connection.id, ["ok"]);
  if (links.length === 0) return { ran: false, issues: 0 };

  const ctx = deps.contextFor(connection);
  const windowMinutes = catchupWindowMinutes(last, new Date(now));
  const ids = [...new Set(links.map((l) => l.issue_id))];
  const changed = new Set<string>();

  for (const chunk of chunkIds(ids)) {
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await ctx.client.searchIssues({ jql: buildCatchupJql(chunk, windowMinutes), fields: ["updated"], nextPageToken: token, maxResults: 100 });
      for (const i of res?.issues ?? []) if (i?.id) changed.add(String(i.id));
      token = res?.nextPageToken;
      if (!token) break;
    }
  }

  let issues = 0;
  if (changed.size > 0) {
    const fetched = await ctx.client.bulkFetch([...changed], await issueFieldList(ctx));
    const byIssue = new Map<string, typeof links>();
    for (const l of links) byIssue.set(l.issue_id, [...(byIssue.get(l.issue_id) ?? []), l]);
    for (const issue of fetched) {
      const mine = byIssue.get(String(issue.id));
      if (!mine?.length) continue;
      await applyIssueToLinks(ctx, issue, mine, { comments: true, source: "catchup" });
      issues += 1;
    }
  }
  await store.updateConnection(connection.id, { last_catchup_at: new Date(now).toISOString() });
  return { ran: true, issues };
}

// ------------------------------------------------------------
// 3. Daily: webhooks, token keep-alive, people
// ------------------------------------------------------------

export async function runDaily(
  deps: CronDeps,
  connection: JiraConnectionRow,
): Promise<{ ran: boolean; webhook?: string; matched?: number }> {
  const now = (deps.now ?? Date.now)();
  if (!webhookRenewalDue(connection, now)) return { ran: false };
  const ctx = deps.contextFor(connection);
  const { store } = deps;

  // Also proves the token still works (and keeps the refresh token from idling out).
  const me = await ctx.client.getMyself();
  if (me && me.displayName && me.displayName !== connection.jira_display_name) {
    await store.updateConnection(connection.id, { jira_display_name: me.displayName });
  }

  const token = await deps.readWebhookToken(connection.id);
  let webhook: string | undefined;
  if (token) {
    const r = await ensureWebhooks({ db: deps.db, store, client: ctx.client, connection, baseUrl: deps.baseUrl, webhookToken: token, now: () => now });
    webhook = r.action;
  }

  let matched = 0;
  try {
    matched = (await autoMatchMembers({ db: deps.db, store, client: ctx.client, accountId: connection.account_id })).matched;
  } catch (e) {
    await store.logEvent({ accountId: connection.account_id, connectionId: connection.id, level: "warn", kind: "user_match_failed", message: describeError(e) });
  }
  return { ran: true, webhook, matched };
}

// ------------------------------------------------------------
// 4. Weekly: Atlassian's personal-data report
// ------------------------------------------------------------

/** Every Jira account id we hold: the user map, cached assignees, comment authors, the connecting user. */
export async function collectAccountIds(db: SupabaseClient, connection: JiraConnectionRow): Promise<string[]> {
  const ids = new Set<string>();
  if (connection.jira_account_id) ids.add(connection.jira_account_id);
  const [{ data: map }, { data: links }, { data: authors }] = await Promise.all([
    db.from("jira_user_map").select("jira_account_id").eq("account_id", connection.account_id),
    db.from("ticket_jira_links").select("assignee_account_id").eq("connection_id", connection.id).not("assignee_account_id", "is", null),
    db.from("jira_comment_map").select("jira_author_account_id").eq("account_id", connection.account_id).not("jira_author_account_id", "is", null),
  ]);
  for (const r of (map as { jira_account_id: string }[] | null) ?? []) ids.add(r.jira_account_id);
  for (const r of (links as { assignee_account_id: string }[] | null) ?? []) ids.add(r.assignee_account_id);
  for (const r of (authors as { jira_author_account_id: string }[] | null) ?? []) ids.add(r.jira_author_account_id);
  return [...ids];
}

/** Erase what Atlassian says must go (`closed`) or refresh (`updated`). */
export async function applyReportResults(
  db: SupabaseClient,
  connection: JiraConnectionRow,
  results: { accountId: string; status: string }[],
): Promise<{ erased: number; refreshed: number }> {
  let erased = 0;
  let refreshed = 0;
  for (const r of results) {
    if (r.status === "closed") {
      await db.from("jira_user_map").delete().eq("account_id", connection.account_id).eq("jira_account_id", r.accountId);
      await db.from("ticket_jira_links").update({ assignee_account_id: null, assignee_name: null }).eq("connection_id", connection.id).eq("assignee_account_id", r.accountId);
      const { data: notes } = await db.from("jira_comment_map").select("ticket_comment_id").eq("account_id", connection.account_id).eq("jira_author_account_id", r.accountId);
      const noteIds = ((notes as { ticket_comment_id: string | null }[] | null) ?? []).map((n) => n.ticket_comment_id).filter((x): x is string => !!x);
      if (noteIds.length) await db.from("ticket_comments").update({ jira_author: "Former Jira user" }).in("id", noteIds).eq("source", "jira");
      await db.from("jira_comment_map").update({ jira_author_account_id: null }).eq("account_id", connection.account_id).eq("jira_author_account_id", r.accountId);
      erased += 1;
    } else if (r.status === "updated") {
      // Names may have changed: drop the cached one, the next sync fills it in again.
      await db.from("ticket_jira_links").update({ assignee_name: null }).eq("connection_id", connection.id).eq("assignee_account_id", r.accountId);
      await db.from("jira_user_map").update({ jira_display_name: null }).eq("account_id", connection.account_id).eq("jira_account_id", r.accountId);
      refreshed += 1;
    }
  }
  return { erased, refreshed };
}

/** After a failed report the next automatic try waits this long (it used to retry on every cron call). */
export const REPORT_RETRY_MS = 6 * 3_600_000;

export async function runWeekly(
  deps: CronDeps,
  connection: JiraConnectionRow,
  opts: { force?: boolean } = {},
): Promise<{ ran: boolean; reported: number; result?: ReportResult }> {
  const now = (deps.now ?? Date.now)();
  const settings = normalizeSettings(connection.settings);
  if (!opts.force) {
    if (!settings.personal_data_report) return { ran: false, reported: 0 };
    const last = connection.last_report_at ? Date.parse(connection.last_report_at) : 0;
    if (Number.isFinite(last) && now - last < REPORT_INTERVAL_MS) return { ran: false, reported: 0 };
    // A report that failed is retried after a few hours, not on every call.
    const failed = connection.last_report_result;
    if (failed && !failed.ok && now - Date.parse(failed.at) < REPORT_RETRY_MS) return { ran: false, reported: 0 };
  }

  const updatedAt = new Date(now).toISOString();
  const ctx = deps.contextFor(connection);
  let reported = 0;
  let erased = 0;
  let refreshed = 0;
  try {
    const ids = await collectAccountIds(deps.db, connection);
    for (let i = 0; i < ids.length; i += 90) {
      const batch = ids.slice(i, i + 90).map((accountId) => ({ accountId, updatedAt }));
      const res = await ctx.client.reportAccounts(batch);
      reported += batch.length;
      const applied = await applyReportResults(deps.db, connection, res);
      erased += applied.erased;
      refreshed += applied.refreshed;
    }
  } catch (e) {
    const result: ReportResult = { at: updatedAt, ok: false, reported, erased, refreshed, error: describeError(e).slice(0, 200) };
    await deps.store.updateConnection(connection.id, { last_report_result: result });
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { reportResult: result });
  }
  const result: ReportResult = { at: updatedAt, ok: true, reported, erased, refreshed };
  await deps.store.updateConnection(connection.id, { last_report_at: updatedAt, last_report_result: result });
  return { ran: true, reported, result };
}

// ------------------------------------------------------------
// The catch-up self-check
// ------------------------------------------------------------

/**
 * A connection with live links whose catch-up has not succeeded for over 30
 * minutes: say so in Diagnostics and tell the workspace owners (once a day).
 * The cron endpoint itself may be what stopped, so Diagnostics also computes
 * this live when it is opened.
 */
export async function checkCatchupStall(
  deps: CronDeps,
  connection: JiraConnectionRow,
): Promise<{ stalled: boolean; minutes: number | null; notified: number }> {
  const now = (deps.now ?? Date.now)();
  const links = await deps.store.linksForConnection(connection.id, ["ok"]);
  const stall = catchupStall({ lastCatchupAt: connection.last_catchup_at, liveLinkCreatedAt: links.map((l) => l.created_at), now });
  if (!stall.stalled) return { stalled: false, minutes: stall.minutes, notified: 0 };
  const notified = await deps.store.notifyStalled(connection.id, stall.minutes ?? 0);
  if (notified > 0) {
    await deps.store.logEvent({
      accountId: connection.account_id,
      connectionId: connection.id,
      level: "error",
      kind: "catchup_stalled",
      message: `No successful catch-up for ${stall.minutes} minutes while ${links.length} link${links.length === 1 ? " is" : "s are"} live. Is the cron line installed? See docs/jira-setup.md.`,
    });
  }
  return { stalled: true, minutes: stall.minutes, notified };
}

// ------------------------------------------------------------
// The whole run
// ------------------------------------------------------------

export async function runCron(deps: CronDeps): Promise<CronReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + (deps.budgetMs ?? 50_000);
  const report: CronReport = {
    jobs: { claimed: 0, done: 0, retried: 0, dead: 0 },
    catchup: { connections: 0, issues: 0, failed: 0, stalled: 0 },
    daily: { connections: 0, webhooks: [], matched: 0 },
    weekly: { reported: 0, failed: 0 },
    pruned: 0,
    ms: 0,
  };

  report.jobs = await runJobs(deps, deadline);

  for (const connection of await deps.store.listActiveConnections()) {
    if (now() >= deadline) break;
    // A step that fails (Jira down, a 429) is logged and does not stop the others.
    const guard = async (kind: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        if (kind === "catchup") report.catchup.failed += 1;
        if (kind === "weekly") report.weekly.failed += 1;
        const level = err instanceof JiraRateLimitError ? "warn" : "error";
        await deps.store.logEvent({
          accountId: connection.account_id,
          connectionId: connection.id,
          level,
          kind: `${kind}_failed`,
          message: describeError(err),
        });
      }
    };

    await guard("catchup", async () => {
      const r = await runCatchup(deps, connection);
      if (r.ran) {
        report.catchup.connections += 1;
        report.catchup.issues += r.issues;
      }
    });
    await guard("stall", async () => {
      // Read it again: the catch-up above may just have succeeded.
      const fresh = (await deps.store.getConnection(connection.id)) ?? connection;
      const r = await checkCatchupStall(deps, fresh);
      if (r.stalled) report.catchup.stalled += 1;
    });
    await guard("daily", async () => {
      const r = await runDaily(deps, connection);
      if (r.ran) {
        report.daily.connections += 1;
        if (r.webhook) report.daily.webhooks.push(r.webhook);
        report.daily.matched += r.matched ?? 0;
      }
    });
    await guard("weekly", async () => {
      const r = await runWeekly(deps, connection);
      report.weekly.reported += r.reported;
    });
  }

  // Housekeeping rides on the daily step (once a day per connection is plenty).
  if (report.daily.connections > 0) {
    try {
      report.pruned = await deps.store.prune();
    } catch {
      // never fails the run
    }
  }
  report.ms = now() - started;
  return report;
}

export { retryDelaySeconds };
