// ============================================================
// Bulk actions on the tickets list (0.45.0): "Create Jira issues" (one per
// selected ticket) and "Link to Jira issue" (all selected tickets to ONE
// issue). At most 25 tickets per action.
//
//   review   nothing is written: each ticket's proposed project / type /
//            summary, and the ones that cannot be created (a required field
//            Vircle cannot fill, five links already, ...)
//   start    one batch row, one item per ticket, one queued job per item
//            (jira_sync_jobs, kind bulk_item)
//   process  the queue runs an item: it is the SAME create / link code as the
//            single-ticket buttons, so the same rules apply (project allow-list,
//            five links, required fields). The client's per-connection
//            concurrency and the shared-pool brake apply to every call; a
//            rate limit puts the item back in the queue with backoff.
//
// Every success and failure is written to jira_sync_events and to the item.
// ============================================================

import { describeError, isJiraError, JiraNotFoundError, JiraPermissionError, JiraValidationError } from "./errors";
import { parseIssueRef, type CreateChoices } from "./create-issue";
import { createIssueFromTicket, LinkError, linkIssueToTicket, planFor } from "./links";
import { effectiveSettings } from "./settings";
import type { BulkItemRow } from "./store";
import { issueFieldList, type SyncContext } from "./sync";
import { MAX_LINKS_PER_TICKET, type JiraIssue } from "./types";

export const MAX_BULK_TICKETS = 25;

export interface BulkProposal {
  ticketId: string;
  ticketKey: string;
  subject: string;
  projectKey: string;
  issueTypeId: string;
  issueTypeName: string | null;
  /** The summary Jira will get (the subject, cut to 255). */
  summary: string;
  canCreate: boolean;
  /** Why not: link_limit | unsupported_fields | required_fields | not_found */
  reason?: string;
  /** The field names behind unsupported_fields / required_fields. */
  fields?: string[];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** The review step of "Create Jira issues". Writes nothing. */
export async function reviewBulkCreate(
  ctx: SyncContext,
  args: { ticketIds: string[]; choices: Pick<CreateChoices, "projectKey" | "issueTypeId" | "issueTypeName"> },
): Promise<BulkProposal[]> {
  const ids = uniqueIds(args.ticketIds).slice(0, MAX_BULK_TICKETS);
  const out: BulkProposal[] = [];
  for (const ticketId of ids) {
    const ticket = await ctx.store.getTicket(ticketId);
    const base = {
      ticketId,
      ticketKey: ticket ? await ctx.store.ticketKey(ticket) : "",
      subject: ticket?.subject ?? "",
      projectKey: args.choices.projectKey,
      issueTypeId: args.choices.issueTypeId,
      issueTypeName: args.choices.issueTypeName ?? null,
    };
    if (!ticket || ticket.account_id !== ctx.connection.account_id) {
      out.push({ ...base, summary: "", canCreate: false, reason: "not_found" });
      continue;
    }
    const links = await ctx.store.linksForTicket(ticket.id);
    try {
      const p = await planFor(ctx, ticket.id, { ...args.choices }, null);
      const summary = p.plan.preview.summary;
      if (links.length >= MAX_LINKS_PER_TICKET) {
        out.push({ ...base, summary, canCreate: false, reason: "link_limit" });
      } else if (p.required.unsupported.length > 0) {
        out.push({ ...base, summary, canCreate: false, reason: "unsupported_fields", fields: p.required.unsupported.map((f) => f.name) });
      } else if (p.required.ask.length > 0) {
        // A required simple field that only a person can fill in cannot be created in bulk.
        out.push({ ...base, summary, canCreate: false, reason: "required_fields", fields: p.required.ask.map((a) => a.field.name) });
      } else {
        out.push({ ...base, summary, canCreate: true });
      }
    } catch (e) {
      if (e instanceof LinkError) out.push({ ...base, summary: ticket.subject.slice(0, 255), canCreate: false, reason: e.code });
      else throw e;
    }
  }
  return out;
}

// ------------------------------------------------------------
// Start
// ------------------------------------------------------------

export interface StartResult {
  batchId: string;
  total: number;
}

export async function startBulkCreate(
  ctx: SyncContext,
  args: {
    items: { ticketId: string; projectKey: string; issueTypeId: string; issueTypeName?: string | null; summary?: string | null }[];
    userId: string | null;
  },
): Promise<StartResult> {
  if (ctx.connection.status !== "active") throw new LinkError("inactive", "The Jira connection needs to be reconnected");
  const seen = new Set<string>();
  const items = args.items.filter((i) => (seen.has(i.ticketId) ? false : (seen.add(i.ticketId), true)));
  if (items.length === 0) throw new LinkError("not_found", "Choose at least one ticket");
  if (items.length > MAX_BULK_TICKETS) throw new LinkError("bulk_limit", `At most ${MAX_BULK_TICKETS} tickets at a time`, { max: MAX_BULK_TICKETS });
  const allowed = ctx.settings.projects.allowed;
  for (const i of items) {
    if (allowed.length > 0 && !allowed.includes(i.projectKey.toUpperCase())) {
      throw new LinkError("project_not_allowed", `Tickets may not link to project ${i.projectKey}`, { project: i.projectKey });
    }
  }
  const { batch, items: rows } = await ctx.store.createBulkBatch({
    accountId: ctx.connection.account_id,
    connectionId: ctx.connection.id,
    kind: "create",
    createdBy: args.userId,
    items,
  });
  await enqueueItems(ctx, batch.id, rows, args.userId);
  return { batchId: batch.id, total: rows.length };
}

export async function startBulkLink(
  ctx: SyncContext,
  args: { ticketIds: string[]; reference: string; userId: string | null },
): Promise<StartResult & { issueKey: string }> {
  if (ctx.connection.status !== "active") throw new LinkError("inactive", "The Jira connection needs to be reconnected");
  const ids = uniqueIds(args.ticketIds);
  if (ids.length === 0) throw new LinkError("not_found", "Choose at least one ticket");
  if (ids.length > MAX_BULK_TICKETS) throw new LinkError("bulk_limit", `At most ${MAX_BULK_TICKETS} tickets at a time`, { max: MAX_BULK_TICKETS });
  const ref = parseIssueRef(args.reference);
  if (!ref) throw new LinkError("bad_reference", "That is not a Jira issue key or link");

  let issue: JiraIssue | null;
  try {
    issue = await ctx.client.getIssue(ref.key, await issueFieldList(ctx));
  } catch (e) {
    if (e instanceof JiraNotFoundError) throw new LinkError("not_found", `Jira could not find ${ref.key}`, { key: ref.key });
    if (e instanceof JiraPermissionError) throw new LinkError("no_permission", `The connected user cannot see ${ref.key}`, { key: ref.key });
    throw e;
  }
  if (!issue) throw new LinkError("not_found", `Jira could not find ${ref.key}`, { key: ref.key });
  const allowed = ctx.settings.projects.allowed;
  const project = issue.fields.project?.key;
  if (allowed.length > 0 && project && !allowed.includes(project.toUpperCase())) {
    throw new LinkError("project_not_allowed", `Tickets may not link to project ${project}`, { project });
  }
  issueCache.set(issue.id, { issue, at: Date.now() });

  const { batch, items: rows } = await ctx.store.createBulkBatch({
    accountId: ctx.connection.account_id,
    connectionId: ctx.connection.id,
    kind: "link",
    createdBy: args.userId,
    targetIssueId: issue.id,
    targetIssueKey: issue.key,
    items: ids.map((ticketId) => ({ ticketId, projectKey: project ?? null })),
  });
  await enqueueItems(ctx, batch.id, rows, args.userId);
  return { batchId: batch.id, total: rows.length, issueKey: issue.key };
}

async function enqueueItems(ctx: SyncContext, batchId: string, rows: BulkItemRow[], userId: string | null): Promise<void> {
  for (const r of rows) {
    await ctx.store.enqueue({
      accountId: ctx.connection.account_id,
      connectionId: ctx.connection.id,
      kind: "bulk_item",
      payload: { batch_id: batchId, item_id: r.id, user_id: userId },
    });
  }
}

// ------------------------------------------------------------
// Process one item (the queue calls this)
// ------------------------------------------------------------

/** The linked issue of a bulk link is read once for the whole batch, not once per ticket. */
const issueCache = new Map<string, { issue: JiraIssue; at: number }>();
const ISSUE_CACHE_MS = 5 * 60_000;

async function targetIssue(ctx: SyncContext, issueId: string): Promise<JiraIssue> {
  const hit = issueCache.get(issueId);
  if (hit && Date.now() - hit.at < ISSUE_CACHE_MS) return hit.issue;
  const issue = await ctx.client.getIssue(issueId, await issueFieldList(ctx));
  if (!issue) throw new JiraNotFoundError();
  issueCache.set(issueId, { issue, at: Date.now() });
  if (issueCache.size > 50) issueCache.delete(issueCache.keys().next().value as string);
  return issue;
}

export function __resetBulkCacheForTests(): void {
  issueCache.clear();
}

export type ItemOutcome = "done" | "failed" | "skipped";

export async function processBulkItem(
  ctx: SyncContext,
  args: { batchId: string; itemId: string; userId: string | null },
): Promise<ItemOutcome | "gone"> {
  const { store } = ctx;
  const item = await store.getBulkItem(args.itemId);
  const batch = await store.getBulkBatch(args.batchId);
  if (!item || !batch || item.batch_id !== batch.id || batch.account_id !== ctx.connection.account_id) return "gone";
  // A retry after the item finished (a crash right after) does nothing twice.
  if (item.status === "done" || item.status === "failed" || item.status === "skipped") return item.status;

  await store.updateBulkItem(item.id, { status: "running" });
  const log = (level: "info" | "warn", kind: string, message: string) =>
    store.logEvent({ accountId: item.account_id, connectionId: ctx.connection.id, level, kind, message });
  const settle = async (status: ItemOutcome, patch: { issue_key?: string | null; code?: string | null; message?: string | null }) => {
    await store.updateBulkItem(item.id, { status, ...patch });
    await log(status === "done" ? "info" : "warn", status === "done" ? "bulk_item_done" : "bulk_item_failed", `bulk ${batch.kind}: ${item.ticket_id} ${status}${patch.issue_key ? ` ${patch.issue_key}` : ""}${patch.code ? ` (${patch.code})` : ""}`);
    return status;
  };

  try {
    if (batch.kind === "create") {
      if (!item.project_key || !item.issue_type_id) return settle("failed", { code: "bad_request", message: "no project or issue type" });
      const customer = await customerFor(ctx, item.ticket_id);
      const link = await createIssueFromTicket(ctx, {
        ticketId: item.ticket_id,
        choices: { projectKey: item.project_key, issueTypeId: item.issue_type_id, issueTypeName: item.issue_type_name ?? undefined },
        rawFieldValues: {},
        customer,
        userId: args.userId,
      });
      return settle("done", { issue_key: link.issue_key });
    }
    if (!batch.target_issue_id) return settle("failed", { code: "bad_request", message: "no target issue" });
    const issue = await targetIssue(ctx, batch.target_issue_id);
    const link = await linkIssueToTicket(ctx, { ticketId: item.ticket_id, issue, userId: args.userId });
    return settle("done", { issue_key: link.issue_key });
  } catch (e) {
    if (e instanceof LinkError) {
      // already linked is not a failure of the batch: the ticket is where the agent wanted it.
      return settle(e.code === "already_linked" ? "skipped" : "failed", { code: e.code, message: e.message.slice(0, 300) });
    }
    if (e instanceof JiraPermissionError) return settle("failed", { code: "no_permission", message: describeError(e) });
    if (e instanceof JiraNotFoundError) return settle("failed", { code: "not_found", message: describeError(e) });
    if (e instanceof JiraValidationError) return settle("failed", { code: "jira_rejected", message: describeError(e) });
    if (isJiraError(e) && e.code === "auth") {
      await store.updateBulkItem(item.id, { status: "pending" });
      throw e;
    }
    // Rate limit, outage or a bug: back to the queue (it backs off and dead-letters eventually).
    await store.updateBulkItem(item.id, { status: "pending" });
    throw e;
  }
}

async function customerFor(ctx: SyncContext, ticketId: string): Promise<{ name: string | null; email: string | null } | null> {
  if (!effectiveSettings(ctx.settings, null).privacy.include_customer) return null;
  const ticket = await ctx.store.getTicket(ticketId);
  return ticket ? ((await ctx.store.getContactBasics(ticket.contact_id)) ?? null) : null;
}

// ------------------------------------------------------------
// Progress
// ------------------------------------------------------------

export interface BulkProgress {
  batchId: string;
  kind: "create" | "link";
  total: number;
  counts: Record<BulkItemRow["status"], number>;
  /** Every item settled (done, failed or skipped). */
  finished: boolean;
  targetIssueKey: string | null;
  items: Pick<BulkItemRow, "id" | "ticket_id" | "status" | "issue_key" | "code" | "message" | "summary" | "project_key">[];
}

export async function bulkProgress(ctx: Pick<SyncContext, "store" | "connection">, batchId: string): Promise<BulkProgress | null> {
  const batch = await ctx.store.getBulkBatch(batchId);
  if (!batch || batch.account_id !== ctx.connection.account_id) return null;
  const items = await ctx.store.listBulkItems(batch.id);
  const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 } as BulkProgress["counts"];
  for (const i of items) counts[i.status] += 1;
  return {
    batchId: batch.id,
    kind: batch.kind,
    total: batch.total,
    counts,
    finished: counts.pending === 0 && counts.running === 0,
    targetIssueKey: batch.target_issue_key,
    items: items.map((i) => ({ id: i.id, ticket_id: i.ticket_id, status: i.status, issue_key: i.issue_key, code: i.code, message: i.message, summary: i.summary, project_key: i.project_key })),
  };
}
