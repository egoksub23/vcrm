// ============================================================
// The two-way sync worker. A job says "sync issue X"; the worker reads the
// issue's CURRENT state from Jira (only the fields it needs, never trusting
// the webhook body) and applies the differences to the tickets linked to it.
//
//   Jira -> Vircle   status (by category, with per-status overrides), assignee
//                    (through the user map, when switched on), comments as
//                    internal notes ("Jira · name"), the cached card data.
//   Vircle -> Jira   a status change asks Jira for its transitions and takes
//                    the one that lands on the mapped status (never a chain);
//                    a note the agent shared is posted as "Name (Vircle): ..."
//                    and edits to it update the Jira comment.
//
// All decisions (echo guards, ordering, mapping) are in ./rules.ts and
// ./settings.ts; this file does the I/O through `JiraStore` and the client,
// both injected, so it is tested with in-memory fakes.
// ============================================================

import { adfToPlainText, buildVircleComment } from "./adf";
import { unseenAttachments, type AttachmentStorage } from "./attachments";
import type { JiraClient } from "./client";
import { describeError, JiraNotFoundError, JiraPermissionError, JiraValidationError } from "./errors";
import { mappedReadFields, pullFieldsIntoTicket } from "./fields-sync";
import type { FieldMappingRow } from "./field-mapping";
import {
  canShareNote,
  decideCommentAction,
  decideCommentDeleted,
  decideStatusApply,
  hashText,
  isOlderEvent,
} from "./rules";
import {
  directionOnAnywhere,
  effectiveSettings,
  normalizeCategory,
  pickTransition,
  transitionFields,
  wantedJiraTarget,
} from "./settings";
import type { CommentMapRow, JiraStore, TicketRow } from "./store";
import {
  ISSUE_FIELDS,
  VIRCLE_COMMENT_PROPERTY,
  type JiraComment,
  type JiraConnectionRow,
  type JiraIssue,
  type JiraSettings,
  type LastPush,
  type TicketJiraLinkRow,
  type TicketStatusValue,
} from "./types";

export type SyncClient = Pick<
  JiraClient,
  | "getIssue"
  | "listComments"
  | "getTransitions"
  | "doTransition"
  | "addComment"
  | "updateComment"
  | "bulkFetch"
  | "searchIssues"
  | "upsertRemoteLink"
  | "listCreateFields"
  | "createIssue"
  | "updateIssue"
  | "getEditMeta"
  | "listProjectComponents"
  | "getAttachmentMeta"
  | "uploadAttachment"
  | "downloadAttachment"
>;

export interface SyncContext {
  store: JiraStore;
  client: SyncClient;
  connection: JiraConnectionRow;
  settings: JiraSettings;
  /** Origin of this deployment, for the link back to a ticket. */
  appUrl: string;
  now?: () => number;
  /** The chat-media bucket (service role); attachments are skipped without it. */
  storage?: AttachmentStorage;
}

/** What one sync run needs beyond the base issue fields, loaded once per context. */
export interface SyncExtras {
  mappings: FieldMappingRow[];
  /** Jira field ids to ask for: the mapped ones, plus `attachment` when attachments are on anywhere. */
  extraFields: string[];
  attachments: boolean;
}

const extrasCache = new WeakMap<object, Promise<SyncExtras>>();

export function syncExtras(ctx: SyncContext): Promise<SyncExtras> {
  let p = extrasCache.get(ctx);
  if (!p) {
    p = (async () => {
      const mappings = (await ctx.store.listFieldMappings(ctx.connection.id)) ?? [];
      const attachments = directionOnAnywhere(ctx.settings, "attachments");
      return { mappings, attachments, extraFields: [...mappedReadFields(mappings), ...(attachments ? ["attachment"] : [])] };
    })();
    extrasCache.set(ctx, p);
  }
  return p;
}

/** The field list of an issue read: the base fields plus what mappings and attachments need. */
export async function issueFieldList(ctx: SyncContext): Promise<string[]> {
  const x = await syncExtras(ctx);
  return [...new Set<string>([...ISSUE_FIELDS, ...x.extraFields])];
}

const nowOf = (ctx: SyncContext) => (ctx.now ?? Date.now)();
const iso = (ctx: SyncContext) => new Date(nowOf(ctx)).toISOString();

export function ticketUrl(ctx: Pick<SyncContext, "appUrl">, ticketId: string): string | null {
  return ctx.appUrl ? `${ctx.appUrl.replace(/\/+$/, "")}/tickets/${ticketId}` : null;
}

export function issueUrl(siteUrl: string, key: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

/** The cached columns of a link, from an issue read. */
export function cachePatch(ctx: Pick<SyncContext, "connection">, issue: JiraIssue, at: string): Record<string, unknown> {
  const f = issue.fields;
  return {
    issue_key: issue.key,
    project_key: f.project?.key ?? null,
    project_name: f.project?.name ?? null,
    issue_type: f.issuetype?.name ?? null,
    summary: f.summary ?? null,
    status_id: f.status?.id ?? null,
    status_name: f.status?.name ?? null,
    status_category: normalizeCategory(f.status?.statusCategory?.key),
    resolution: f.resolution?.name ?? null,
    priority_name: f.priority?.name ?? null,
    assignee_account_id: f.assignee?.accountId ?? null,
    assignee_name: f.assignee?.displayName ?? null,
    reporter_name: f.reporter?.displayName ?? null,
    issue_url: issueUrl(ctx.connection.site_url, issue.key),
    jira_updated_at: f.updated ? new Date(f.updated).toISOString() : null,
    last_synced_at: at,
    sync_state: "ok",
    sync_error: null,
  };
}

// ------------------------------------------------------------
// Jira -> Vircle
// ------------------------------------------------------------

export interface SyncHint {
  /** Read the comments too (a comment event, the catch-up, Sync now). */
  comments?: boolean;
  source?: "webhook" | "catchup" | "manual" | "job";
  /** The first read of a new link: existing comments are noted as seen, not imported. */
  seedComments?: boolean;
}

export interface SyncResult {
  links: number;
  skipped?: "no_links" | "connection_inactive";
  broken?: string;
  statusApplied?: { ticketId: string; status: TicketStatusValue }[];
  droppedOlder?: number;
}

async function markBroken(ctx: SyncContext, links: TicketJiraLinkRow[], reason: string): Promise<void> {
  for (const l of links) {
    await ctx.store.updateLink(l.id, { sync_state: "broken", sync_error: reason });
    await ctx.store.logEvent({
      accountId: l.account_id,
      connectionId: ctx.connection.id,
      linkId: l.id,
      level: "warn",
      kind: "link_broken",
      message: `${l.issue_key}: ${reason}`,
    });
  }
}

/** Sync every ticket linked to one issue. */
export async function syncIssue(ctx: SyncContext, issueId: string, hint: SyncHint = {}): Promise<SyncResult> {
  if (ctx.connection.status !== "active") return { links: 0, skipped: "connection_inactive" };
  const links = (await ctx.store.linksForIssue(ctx.connection.id, issueId)).filter((l) => l.sync_state !== "paused");
  if (links.length === 0) return { links: 0, skipped: "no_links" };

  let issue: JiraIssue | null;
  try {
    issue = await ctx.client.getIssue(issueId, await issueFieldList(ctx));
  } catch (e) {
    // Deleted or no longer visible: the link becomes "broken", last known data stays.
    if (e instanceof JiraNotFoundError) {
      await markBroken(ctx, links, "not_found");
      return { links: links.length, broken: "not_found" };
    }
    // 403 is a clear message on the card, not a retry storm.
    if (e instanceof JiraPermissionError) {
      await markBroken(ctx, links, "no_access");
      return { links: links.length, broken: "no_access" };
    }
    throw e;
  }
  if (!issue) {
    await markBroken(ctx, links, "not_found");
    return { links: links.length, broken: "not_found" };
  }

  return applyIssueToLinks(ctx, issue, links, hint);
}

/** Apply one issue read (from a GET or a bulk fetch) to each of its links. */
export async function applyIssueToLinks(
  ctx: SyncContext,
  issue: JiraIssue,
  links: TicketJiraLinkRow[],
  hint: SyncHint = {},
): Promise<SyncResult> {
  const result: SyncResult = { links: links.length, statusApplied: [], droppedOlder: 0 };
  for (const link of links) {
    const r = await applyIssueToLink(ctx, link, issue, hint);
    if (r.droppedOlder) result.droppedOlder = (result.droppedOlder ?? 0) + 1;
    if (r.statusApplied) result.statusApplied?.push(r.statusApplied);
  }
  return result;
}

interface ApplyResult {
  droppedOlder?: boolean;
  statusApplied?: { ticketId: string; status: TicketStatusValue };
}

/** Apply one issue read to one link (and its ticket). Idempotent. */
export async function applyIssueToLink(
  ctx: SyncContext,
  link: TicketJiraLinkRow,
  issue: JiraIssue,
  hint: SyncHint = {},
): Promise<ApplyResult> {
  const { store } = ctx;
  // The most specific setting wins: this project's overrides over the workspace's.
  const settings = effectiveSettings(ctx.settings, f0(issue) ?? link.project_key);
  const f = issue.fields;
  const at = iso(ctx);

  // Guard 5: an event older than what we already applied is dropped.
  if (isOlderEvent(f.updated, link.jira_updated_at)) {
    await store.logEvent({
      accountId: link.account_id,
      connectionId: ctx.connection.id,
      linkId: link.id,
      level: "info",
      kind: "dropped_older",
      message: `${issue.key}: older than the last change applied`,
    });
    return { droppedOlder: true };
  }

  const ticket = await store.getTicket(link.ticket_id);
  if (!ticket) return {};

  const patch = cachePatch(ctx, issue, at);
  const result: ApplyResult = {};

  if (link.issue_key !== issue.key) {
    await store.logEvent({
      accountId: link.account_id,
      connectionId: ctx.connection.id,
      linkId: link.id,
      level: "info",
      kind: "issue_moved",
      message: `${link.issue_key} is now ${issue.key}`,
    });
  }

  // ----- status -----
  const statusNow = {
    id: f.status?.id ?? null,
    name: f.status?.name ?? null,
    category: f.status?.statusCategory?.key ?? null,
  };
  const siblings = (await store.linksForTicket(link.ticket_id)).filter((l) => l.id !== link.id && l.sync_state !== "broken");
  const decision = decideStatusApply({
    settings,
    cached: link,
    now: statusNow,
    ticketStatus: ticket.status as TicketStatusValue,
    otherLinksAllDone: siblings.every((l) => l.status_category === "done"),
    at: nowOf(ctx),
  });

  if (decision.apply) {
    const changed = await store.applyTicketStatus(ticket.id, decision.apply, issue.key);
    if (changed) {
      result.statusApplied = { ticketId: ticket.id, status: decision.apply };
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "info",
        kind: "status_applied",
        message: `${issue.key} ${statusNow.name ?? ""} -> ${decision.apply}`,
      });
    }
  } else if (decision.reason === "done_note") {
    await notifyDone(ctx, ticket, issue.key);
  }

  // ----- assignee (only inward, only with the toggle and a user map) -----
  if (settings.direction.assignee) {
    const before = link.assignee_account_id ?? null;
    const now = f.assignee?.accountId ?? null;
    if (now && now !== before) {
      const userId = await store.userIdForJiraAccount(link.account_id, now);
      if (userId && userId !== ticket.assigned_agent_id) await store.setTicketAssignee(ticket.id, userId);
    }
  }

  await store.updateLink(link.id, patch);

  // ----- custom fields and attachments (0.45.0) -----
  const extras = await syncExtras(ctx);
  if (extras.mappings.length > 0) {
    try {
      await pullFieldsIntoTicket(ctx, link, issue, ticket, extras.mappings);
    } catch (e) {
      // A field that cannot be applied never blocks status and comments; say so in Diagnostics.
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "warn",
        kind: "fields_pull_failed",
        message: `${issue.key}: ${describeError(e)}`,
      });
    }
  }
  if (settings.direction.attachments && Array.isArray(f.attachment)) {
    const unseen = unseenAttachments(issue, await store.listAttachmentMaps(link.id), link.created_at);
    // The downloads run as their own job: this one stays quick.
    if (unseen.length > 0) {
      await store.enqueue({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        kind: "pull_attachments",
        payload: { link_id: link.id },
        dedupeKey: `pullatt:${link.id}`,
      });
    }
  }

  // ----- comments -----
  if (hint.comments !== false) {
    const seed = hint.seedComments ?? false;
    await syncComments(ctx, { ...link, ...(patch as Partial<TicketJiraLinkRow>) } as TicketJiraLinkRow, issue, ticket, seed);
  }
  return result;
}

const f0 = (issue: JiraIssue): string | null => issue.fields.project?.key ?? null;

async function notifyDone(ctx: SyncContext, ticket: TicketRow, key: string): Promise<void> {
  const { store } = ctx;
  await store.insertNote({
    ticketId: ticket.id,
    accountId: ticket.account_id,
    body: `${key} is Done in Jira.`,
    jiraAuthor: "Jira",
    jiraCommentId: null,
  });
  await store.notifyTicketOwner({
    ticket,
    type: "jira_issue_done",
    title: "Jira issue is Done",
    body: `${key} is Done in Jira: ${ticket.subject}`,
  });
}

/** Read the issue's comments and mirror them as internal notes (create, update, "deleted in Jira"). */
export async function syncComments(
  ctx: SyncContext,
  link: TicketJiraLinkRow,
  issue: JiraIssue,
  ticket: TicketRow,
  seedOnly: boolean,
): Promise<void> {
  const { store } = ctx;

  const comments: JiraComment[] = [];
  let complete = false;
  for (let page = 0; page < 5; page++) {
    const res = await ctx.client.listComments(issue.id, { startAt: comments.length, maxResults: 100 });
    const got = res?.comments ?? [];
    comments.push(...got);
    if (got.length < 100 || (res?.total != null && comments.length >= res.total)) {
      complete = true;
      break;
    }
  }

  const maps = new Map((await store.getMapsForLink(link.id)).map((m) => [m.jira_comment_id, m]));
  const seen = new Set<string>();

  for (const c of comments) {
    if (!c?.id) continue;
    seen.add(c.id);
    const mapped = maps.get(c.id) ?? null;
    const text = adfToPlainText(c.body, { max: 20_000 });
    const action = decideCommentAction({
      comment: c as JiraComment & { visibility?: unknown },
      text,
      mapped,
      commentsFromJira: effectiveSettings(ctx.settings, link.project_key).direction.comments_from_jira,
      seedOnly,
    });
    const base = {
      account_id: link.account_id,
      link_id: link.id,
      jira_comment_id: c.id,
      jira_author_account_id: c.author?.accountId ?? null,
      body_hash: hashText(text),
      jira_updated_at: c.updated ? new Date(c.updated).toISOString() : null,
      deleted_in_jira: false,
    };

    switch (action.kind) {
      case "remember_ours":
        await store.insertMap({ ...base, ticket_comment_id: null, origin: "vircle" });
        break;
      case "seed":
        await store.insertMap({ ...base, ticket_comment_id: null, origin: "jira" });
        break;
      case "create": {
        // Claim the Jira comment id first (unique per link): a concurrent worker loses and creates nothing.
        const claimed = await store.insertMap({ ...base, ticket_comment_id: null, origin: "jira" });
        if (!claimed) break;
        const noteId = await store.insertNote({
          ticketId: ticket.id,
          accountId: ticket.account_id,
          body: text,
          jiraAuthor: c.author?.displayName || "Jira user",
          jiraCommentId: c.id,
        });
        const row = await store.getMapByJiraComment(link.id, c.id);
        if (row) await store.updateMap(row.id, { ticket_comment_id: noteId });
        break;
      }
      case "update":
        if (mapped?.ticket_comment_id) {
          await store.updateNote(mapped.ticket_comment_id, { body: text });
          await store.updateMap(mapped.id, { body_hash: base.body_hash, jira_updated_at: base.jira_updated_at });
        }
        break;
      default:
        break;
    }
  }

  // Comments we know from Jira that it no longer lists: kept, marked "deleted in Jira".
  if (complete) {
    for (const m of maps.values()) {
      if (seen.has(m.jira_comment_id)) continue;
      const del = decideCommentDeleted(m);
      if (del.kind === "mark_deleted") {
        if (m.ticket_comment_id) await store.updateNote(m.ticket_comment_id, { deleted_in_jira: true });
        await store.updateMap(m.id, { deleted_in_jira: true });
      }
    }
  }
}

// ------------------------------------------------------------
// Vircle -> Jira: status
// ------------------------------------------------------------

export interface PushResult {
  links: { linkId: string; key: string; result: LastPush }[];
}

/**
 * A ticket status changed in Vircle and "status to Jira" is on: move each
 * linked issue to the mapped status through ONE transition. Where there is no
 * such transition Jira is left alone and the link records why (the card
 * shows it).
 */
export async function pushStatus(ctx: SyncContext, args: { ticketId: string; status: TicketStatusValue }): Promise<PushResult> {
  const { store, settings: base } = ctx;
  const out: PushResult = { links: [] };
  if (!directionOnAnywhere(base, "status_to_jira") || ctx.connection.status !== "active") return out;

  const ticket = await store.getTicket(args.ticketId);
  if (!ticket || ticket.status !== args.status) return out; // changed again meanwhile: a newer job follows

  const target = wantedJiraTarget(base, args.status);
  // Only the links whose project (or the workspace) has "status to Jira" on.
  const links = (await store.linksForTicket(ticket.id)).filter(
    (l) => l.sync_state === "ok" && effectiveSettings(base, l.project_key).direction.status_to_jira,
  );

  for (const link of links) {
    const settings = effectiveSettings(base, link.project_key);
    const at = iso(ctx);
    let last: LastPush;
    if (!target) {
      // pending / closed have no Jira twin unless the admin mapped them.
      last = { ok: true, reason: "not_mapped", wanted: args.status, at };
      await store.updateLink(link.id, { last_push: last });
      out.links.push({ linkId: link.id, key: link.issue_key, result: last });
      continue;
    }
    const wanted = target.name ?? target.category ?? args.status;
    try {
      const fresh = await ctx.client.getIssue(link.issue_id, ISSUE_FIELDS);
      const current = { name: fresh?.fields.status?.name ?? link.status_name, category: fresh?.fields.status?.statusCategory?.key ?? link.status_category };
      const transitions = (await ctx.client.getTransitions(link.issue_id))?.transitions ?? [];
      const choice = pickTransition(transitions, target, current);

      if (choice.kind === "already") {
        last = { ok: true, reason: "already", wanted, at };
      } else if (choice.kind === "none") {
        last = { ok: false, reason: "no_transition", wanted, at };
        await store.logEvent({
          accountId: link.account_id,
          connectionId: ctx.connection.id,
          linkId: link.id,
          level: "warn",
          kind: "push_no_transition",
          message: `${link.issue_key}: no transition to ${wanted}`,
        });
      } else {
        const fields = transitionFields(choice.transition, settings.resolution);
        if (!fields.ok) {
          last = { ok: false, reason: "screen_fields", wanted, at };
        } else {
          await ctx.client.doTransition(link.issue_id, choice.transition.id, fields.fields);
          const toCategory = normalizeCategory(choice.transition.to?.statusCategory?.key);
          last = { ok: true, reason: "moved", wanted, at };
          // Guard 3: remember what we wrote, so the webhook announcing it is recognised.
          await store.updateLink(link.id, {
            last_written: {
              status_category: toCategory ?? undefined,
              status_name: choice.transition.to?.name,
              at,
            },
            status_id: choice.transition.to?.id ?? link.status_id,
            status_name: choice.transition.to?.name ?? link.status_name,
            status_category: toCategory ?? link.status_category,
          });
          await store.addActivity({
            ticketId: ticket.id,
            accountId: ticket.account_id,
            eventType: "jira_status_pushed",
            actorId: null,
            toValue: choice.transition.to?.name ?? null,
            detail: link.issue_key,
          });
        }
      }
    } catch (e) {
      if (e instanceof JiraPermissionError) last = { ok: false, reason: "permission", wanted, at };
      else if (e instanceof JiraNotFoundError) {
        await markBroken(ctx, [link], "not_found");
        last = { ok: false, reason: "not_found", wanted, at };
      } else if (e instanceof JiraValidationError) last = { ok: false, reason: "screen_fields", wanted, at };
      else throw e; // retryable: the queue backs off
    }
    await store.updateLink(link.id, { last_push: last });
    out.links.push({ linkId: link.id, key: link.issue_key, result: last });
  }
  return out;
}

// ------------------------------------------------------------
// Vircle -> Jira: comments
// ------------------------------------------------------------

export interface ShareResult {
  linkId: string;
  key: string;
  ok: boolean;
  /** shared | already | error code */
  code: string;
}

/**
 * "Share with Jira": post an internal note to every active linked issue (or
 * just `linkId`) as "Name (Vircle): text". The comment id is recorded the
 * moment Jira answers, before any webhook can announce it (guard 1); the
 * comment also carries a property marker in case the webhook is faster.
 */
export async function shareNoteToJira(
  ctx: SyncContext,
  args: { noteId: string; actorUserId: string | null; linkId?: string },
): Promise<ShareResult[]> {
  const { store } = ctx;
  if (!directionOnAnywhere(ctx.settings, "comments_to_jira")) {
    return [{ linkId: args.linkId ?? "", key: "", ok: false, code: "toggle_off" }];
  }
  const note = await store.getNote(args.noteId);
  if (!note || !canShareNote(note)) return [{ linkId: args.linkId ?? "", key: "", ok: false, code: "not_shareable" }];

  const ticket = await store.getTicket(note.ticket_id);
  if (!ticket || ticket.account_id !== ctx.connection.account_id) return [{ linkId: args.linkId ?? "", key: "", ok: false, code: "not_found" }];

  const allLinks = (await store.linksForTicket(ticket.id)).filter((l) => l.sync_state === "ok" && (!args.linkId || l.id === args.linkId));
  // A project that switches comments to Jira off keeps its issues out of "Share with Jira".
  const links = allLinks.filter((l) => effectiveSettings(ctx.settings, l.project_key).direction.comments_to_jira);
  if (allLinks.length > 0 && links.length === 0) return [{ linkId: args.linkId ?? "", key: "", ok: false, code: "toggle_off" }];
  const name = (await store.memberName(args.actorUserId ?? note.author_id ?? "")) ?? "Someone";
  const existing = await store.getMapsForNote(note.id);
  const results: ShareResult[] = [];
  let retryable: unknown = null;

  for (const link of links) {
    if (existing.some((m) => m.link_id === link.id)) {
      results.push({ linkId: link.id, key: link.issue_key, ok: true, code: "already" });
      continue;
    }
    try {
      const built = buildVircleComment({ agentName: name, text: note.body, ticketUrl: ticketUrl(ctx, ticket.id) });
      const comment = await ctx.client.addComment(link.issue_id, built.doc, [
        { key: VIRCLE_COMMENT_PROPERTY, value: { v: 1, note: note.id } },
      ]);
      if (comment?.id) {
        await store.insertMap({
          account_id: link.account_id,
          link_id: link.id,
          ticket_comment_id: note.id,
          jira_comment_id: String(comment.id),
          origin: "vircle",
          jira_author_account_id: comment.author?.accountId ?? null,
          body_hash: hashText(note.body),
          jira_updated_at: comment.updated ? new Date(comment.updated).toISOString() : null,
          deleted_in_jira: false,
        });
      }
      results.push({ linkId: link.id, key: link.issue_key, ok: true, code: "shared" });
    } catch (e) {
      const code = e instanceof JiraPermissionError ? "permission" : e instanceof JiraNotFoundError ? "not_found" : (e as { code?: string })?.code ?? "error";
      results.push({ linkId: link.id, key: link.issue_key, ok: false, code });
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "warn",
        kind: "share_failed",
        message: `${link.issue_key}: ${describeError(e)}`,
      });
      if ((e as { retryable?: boolean })?.retryable) retryable = e;
    }
  }
  // Let the queue retry what may pass; what was shared is remembered, so a retry is idempotent.
  if (retryable && args.linkId === undefined) throw retryable;
  return results;
}

/** A shared note was edited in Vircle: update the Jira comment. (A delete in Vircle never deletes in Jira.) */
export async function editSharedNote(ctx: SyncContext, noteId: string): Promise<number> {
  const { store } = ctx;
  const note = await store.getNote(noteId);
  if (!note || !canShareNote(note)) return 0;
  const ticket = await store.getTicket(note.ticket_id);
  if (!ticket) return 0;
  const maps = (await store.getMapsForNote(noteId)).filter((m) => m.origin === "vircle" && !m.deleted_in_jira);
  const hash = hashText(note.body);
  const name = (await store.memberName(note.author_id ?? "")) ?? "Someone";
  let updated = 0;
  for (const m of maps) {
    if (m.body_hash === hash) continue;
    const link = await store.getLink(m.link_id);
    if (!link || link.sync_state !== "ok") continue;
    const built = buildVircleComment({ agentName: name, text: note.body, ticketUrl: ticketUrl(ctx, ticket.id) });
    try {
      await ctx.client.updateComment(link.issue_id, m.jira_comment_id, built.doc);
    } catch (e) {
      if (e instanceof JiraNotFoundError) {
        await store.updateMap(m.id, { deleted_in_jira: true });
        continue;
      }
      throw e;
    }
    await store.updateMap(m.id, { body_hash: hash });
    updated += 1;
  }
  return updated;
}

// ------------------------------------------------------------
// Sync now (with its rate limit)
// ------------------------------------------------------------

/** A per-link resync is allowed once per 30 seconds. */
export const RESYNC_MIN_INTERVAL_MS = 30_000;

export function resyncWaitMs(link: Pick<TicketJiraLinkRow, "last_resync_at">, now: number): number {
  if (!link.last_resync_at) return 0;
  const t = Date.parse(link.last_resync_at);
  return Number.isFinite(t) ? Math.max(0, RESYNC_MIN_INTERVAL_MS - (now - t)) : 0;
}

export async function resyncLink(ctx: SyncContext, linkId: string): Promise<SyncResult & { tooSoonMs?: number }> {
  const link = await ctx.store.getLink(linkId);
  if (!link || link.account_id !== ctx.connection.account_id) return { links: 0, skipped: "no_links" };
  const wait = resyncWaitMs(link, nowOf(ctx));
  if (wait > 0) return { links: 0, tooSoonMs: wait };
  await ctx.store.updateLink(link.id, { last_resync_at: iso(ctx) });
  // Sync now also revives a broken link if the issue is readable again.
  return syncIssue(ctx, link.issue_id, { comments: true, source: "manual" });
}

export type { CommentMapRow };
