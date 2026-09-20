// ============================================================
// Everything the Jira sync reads and writes in the database, behind one
// interface. The sync logic (./sync.ts, ./links.ts, ./cron.ts) only talks to
// `JiraStore`, so its echo guards and queue behaviour are unit-tested against
// an in-memory store; `SupabaseJiraStore` is the real one (service role).
//
// Nothing here selects a token column: tokens live in jira_connection_secrets
// and are only read by ./service.ts (the token store).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { FieldMappingRow, VircleFieldDef } from "./field-mapping";
import {
  CONNECTION_COLUMNS,
  type FieldState,
  type JiraConnectionRow,
  type TicketJiraLinkRow,
} from "./types";

export interface TicketRow {
  id: string;
  account_id: string;
  ticket_number: number;
  contact_id: string;
  subject: string;
  description: string | null;
  category: string;
  status: string;
  priority: string;
  assigned_agent_id: string | null;
  created_by: string | null;
  /** Migration 066: custom field values keyed by definition id. */
  custom_fields?: Record<string, unknown> | null;
}

export const TICKET_COLUMNS =
  "id, account_id, ticket_number, contact_id, subject, description, category, status, priority, assigned_agent_id, created_by, custom_fields";

export interface TicketAttachmentRow {
  id: string;
  ticket_id: string;
  account_id: string;
  storage_path: string;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  source?: string | null;
  jira_attachment_id?: string | null;
}

export interface AttachmentMapRow {
  id: string;
  account_id: string;
  link_id: string;
  ticket_attachment_id: string | null;
  jira_attachment_id: string;
  direction: "to_jira" | "from_jira";
  status: "synced" | "skipped_type" | "skipped_size" | "skipped_cap" | "failed" | "duplicate";
  content_hash: string | null;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  jira_url: string | null;
  error: string | null;
}

export interface BulkBatchRow {
  id: string;
  account_id: string;
  connection_id: string;
  kind: "create" | "link";
  created_by: string | null;
  total: number;
  target_issue_id: string | null;
  target_issue_key: string | null;
  created_at: string;
}

export interface BulkItemRow {
  id: string;
  batch_id: string;
  account_id: string;
  ticket_id: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  project_key: string | null;
  issue_type_id: string | null;
  issue_type_name: string | null;
  summary: string | null;
  issue_key: string | null;
  code: string | null;
  message: string | null;
}

export interface FieldMetaCacheRow {
  fields: unknown;
  fetched_at: string;
}

export interface NoteRow {
  id: string;
  ticket_id: string;
  account_id: string;
  author_id: string | null;
  body: string;
  source: string;
  jira_author: string | null;
  jira_comment_id: string | null;
  deleted_in_jira: boolean;
}

export interface CommentMapRow {
  id: string;
  account_id: string;
  link_id: string;
  ticket_comment_id: string | null;
  jira_comment_id: string;
  origin: "vircle" | "jira";
  jira_author_account_id: string | null;
  body_hash: string | null;
  jira_updated_at: string | null;
  deleted_in_jira: boolean;
}

export interface SyncEventInput {
  accountId: string;
  connectionId: string | null;
  linkId?: string | null;
  level: "info" | "warn" | "error";
  kind: string;
  message: string;
  details?: Record<string, unknown> | null;
}

export type JobKind =
  | "sync_issue"
  | "push_status"
  | "post_comment"
  | "edit_comment"
  | "push_fields"
  | "push_attachment"
  | "pull_attachments"
  | "bulk_item";

export interface JobRow {
  id: string;
  account_id: string;
  connection_id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
}

export interface UserMapRow {
  id: string;
  account_id: string;
  user_id: string;
  jira_account_id: string;
  jira_display_name: string | null;
  method: "email" | "manual";
}

export interface JiraStore {
  // connection
  getConnection(id: string): Promise<JiraConnectionRow | null>;
  getConnectionByAccount(accountId: string): Promise<JiraConnectionRow | null>;
  listActiveConnections(): Promise<JiraConnectionRow[]>;
  updateConnection(id: string, patch: Record<string, unknown>): Promise<void>;
  markReauth(connectionId: string, reason: string): Promise<void>;

  // links
  getLink(id: string): Promise<TicketJiraLinkRow | null>;
  linksForIssue(connectionId: string, issueId: string): Promise<TicketJiraLinkRow[]>;
  linksForTicket(ticketId: string): Promise<TicketJiraLinkRow[]>;
  linksForConnection(connectionId: string, states?: string[]): Promise<TicketJiraLinkRow[]>;
  insertLink(row: Record<string, unknown>): Promise<TicketJiraLinkRow>;
  updateLink(id: string, patch: Record<string, unknown>): Promise<void>;
  deleteLink(id: string): Promise<void>;

  // tickets and notes
  getTicket(id: string): Promise<TicketRow | null>;
  ticketKey(ticket: Pick<TicketRow, "account_id" | "ticket_number">): Promise<string>;
  applyTicketStatus(ticketId: string, status: string, issueKey: string): Promise<boolean>;
  setTicketAssignee(ticketId: string, userId: string): Promise<void>;
  insertNote(input: { ticketId: string; accountId: string; body: string; jiraAuthor: string; jiraCommentId: string | null }): Promise<string>;
  getNote(id: string): Promise<NoteRow | null>;
  updateNote(id: string, patch: { body?: string; deleted_in_jira?: boolean }): Promise<void>;
  addActivity(input: {
    ticketId: string;
    accountId: string;
    eventType: string;
    actorId?: string | null;
    fromValue?: string | null;
    toValue?: string | null;
    detail?: string | null;
  }): Promise<void>;
  notifyTicketOwner(input: { ticket: TicketRow; type: string; title: string; body: string }): Promise<void>;

  // comment map
  getMapByJiraComment(linkId: string, jiraCommentId: string): Promise<CommentMapRow | null>;
  getMapsForNote(noteId: string): Promise<CommentMapRow[]>;
  getMapsForLink(linkId: string): Promise<CommentMapRow[]>;
  /** False when the Jira comment was already recorded (a concurrent worker won). */
  insertMap(row: Omit<CommentMapRow, "id">): Promise<boolean>;
  updateMap(id: string, patch: Partial<Omit<CommentMapRow, "id">>): Promise<void>;

  /** The customer of a ticket (name and email), for the "include customer" privacy option. */
  getContactBasics(contactId: string): Promise<{ name: string | null; email: string | null } | null>;

  // custom fields (0.45.0)
  listFieldMappings(connectionId: string): Promise<FieldMappingRow[]>;
  getFieldDefinitions(accountId: string): Promise<VircleFieldDef[]>;
  /** Set (or, with null, clear) custom field values on a ticket as "from Jira": nothing is queued back. */
  applyTicketFields(ticketId: string, values: Record<string, unknown>): Promise<boolean>;
  setFieldState(linkId: string, state: Record<string, FieldState>): Promise<void>;

  // attachments (0.45.0)
  getTicketAttachment(id: string): Promise<TicketAttachmentRow | null>;
  countTicketAttachments(ticketId: string): Promise<number>;
  insertTicketAttachment(input: {
    ticketId: string;
    accountId: string;
    storagePath: string;
    url: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    jiraAttachmentId: string;
  }): Promise<string>;
  deleteTicketAttachment(id: string): Promise<void>;
  listAttachmentMaps(linkId: string): Promise<AttachmentMapRow[]>;
  /** False when the Jira attachment (or the same file on the issue) was already recorded. */
  insertAttachmentMap(row: Omit<AttachmentMapRow, "id">): Promise<boolean>;

  // bulk actions (0.45.0)
  createBulkBatch(input: {
    accountId: string;
    connectionId: string;
    kind: "create" | "link";
    createdBy: string | null;
    targetIssueId?: string | null;
    targetIssueKey?: string | null;
    items: { ticketId: string; projectKey?: string | null; issueTypeId?: string | null; issueTypeName?: string | null; summary?: string | null }[];
  }): Promise<{ batch: BulkBatchRow; items: BulkItemRow[] }>;
  getBulkBatch(id: string): Promise<BulkBatchRow | null>;
  getBulkItem(id: string): Promise<BulkItemRow | null>;
  listBulkItems(batchId: string): Promise<BulkItemRow[]>;
  updateBulkItem(id: string, patch: Partial<Pick<BulkItemRow, "status" | "issue_key" | "code" | "message">>): Promise<void>;

  // health (0.45.0)
  /** Tell the workspace owners the catch-up has stalled (at most once a day). */
  notifyStalled(connectionId: string, minutes: number): Promise<number>;
  bumpWebhookStat(connectionId: string, kind: "signed" | "unsigned" | "rejected_unsigned"): Promise<void>;

  // people
  userIdForJiraAccount(accountId: string, jiraAccountId: string): Promise<string | null>;
  jiraAccountForUser(accountId: string, userId: string): Promise<string | null>;
  memberName(userId: string): Promise<string | null>;
  listUserMap(accountId: string): Promise<UserMapRow[]>;

  // queue and diagnostics
  enqueue(input: {
    accountId: string;
    connectionId: string;
    kind: JobRow["kind"];
    payload: Record<string, unknown>;
    dedupeKey?: string;
    delaySeconds?: number;
  }): Promise<void>;
  claimJobs(limit: number, worker: string, leaseSeconds: number): Promise<JobRow[]>;
  finishJob(id: string, worker: string, outcome: "ok" | "retry" | "dead", error: string | null, retrySeconds: number): Promise<string>;
  prune(): Promise<number>;
  logEvent(e: SyncEventInput): Promise<void>;
  audit(input: {
    accountId: string;
    actorId: string | null;
    action: "connected" | "disconnected" | "reconnected" | "linked" | "unlinked" | "updated" | "created";
    entityType: "jira_connection" | "ticket_jira_link";
    entityId: string | null;
    label: string;
    summary?: Record<string, unknown> | null;
  }): Promise<void>;
}

function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`jira store: ${what} failed: ${error?.message ?? "unknown error"}`);
}

/** The real store, on the service-role client. */
export class SupabaseJiraStore implements JiraStore {
  constructor(private readonly db: SupabaseClient) {}

  async getConnection(id: string) {
    const { data, error } = await this.db.from("jira_connections").select(CONNECTION_COLUMNS).eq("id", id).maybeSingle();
    if (error) fail("getConnection", error);
    return (data as JiraConnectionRow | null) ?? null;
  }

  async getConnectionByAccount(accountId: string) {
    const { data, error } = await this.db.from("jira_connections").select(CONNECTION_COLUMNS).eq("account_id", accountId).maybeSingle();
    if (error) fail("getConnectionByAccount", error);
    return (data as JiraConnectionRow | null) ?? null;
  }

  async listActiveConnections() {
    const { data, error } = await this.db.from("jira_connections").select(CONNECTION_COLUMNS).eq("status", "active");
    if (error) fail("listActiveConnections", error);
    return (data as JiraConnectionRow[]) ?? [];
  }

  async updateConnection(id: string, patch: Record<string, unknown>) {
    const { error } = await this.db.from("jira_connections").update(patch).eq("id", id);
    if (error) fail("updateConnection", error);
  }

  async markReauth(connectionId: string, reason: string) {
    const { error } = await this.db.rpc("jira_mark_reauth", { p_connection_id: connectionId, p_reason: reason });
    if (error) fail("markReauth", error);
  }

  async getLink(id: string) {
    const { data, error } = await this.db.from("ticket_jira_links").select("*").eq("id", id).maybeSingle();
    if (error) fail("getLink", error);
    return (data as TicketJiraLinkRow | null) ?? null;
  }

  async linksForIssue(connectionId: string, issueId: string) {
    const { data, error } = await this.db
      .from("ticket_jira_links")
      .select("*")
      .eq("connection_id", connectionId)
      .eq("issue_id", issueId);
    if (error) fail("linksForIssue", error);
    return (data as TicketJiraLinkRow[]) ?? [];
  }

  async linksForTicket(ticketId: string) {
    const { data, error } = await this.db.from("ticket_jira_links").select("*").eq("ticket_id", ticketId).order("created_at");
    if (error) fail("linksForTicket", error);
    return (data as TicketJiraLinkRow[]) ?? [];
  }

  async linksForConnection(connectionId: string, states?: string[]) {
    let q = this.db.from("ticket_jira_links").select("*").eq("connection_id", connectionId);
    if (states?.length) q = q.in("sync_state", states);
    const { data, error } = await q;
    if (error) fail("linksForConnection", error);
    return (data as TicketJiraLinkRow[]) ?? [];
  }

  async insertLink(row: Record<string, unknown>) {
    const { data, error } = await this.db.from("ticket_jira_links").insert(row).select("*").single();
    if (error || !data) {
      const e = new Error(error?.message ?? "insert failed") as Error & { code?: string; hint?: string };
      e.code = error?.code;
      e.hint = error?.hint;
      throw e;
    }
    return data as TicketJiraLinkRow;
  }

  async updateLink(id: string, patch: Record<string, unknown>) {
    const { error } = await this.db.from("ticket_jira_links").update(patch).eq("id", id);
    if (error) fail("updateLink", error);
  }

  async deleteLink(id: string) {
    const { error } = await this.db.from("ticket_jira_links").delete().eq("id", id);
    if (error) fail("deleteLink", error);
  }

  async getTicket(id: string) {
    const { data, error } = await this.db.from("tickets").select(TICKET_COLUMNS).eq("id", id).maybeSingle();
    if (error) fail("getTicket", error);
    return (data as TicketRow | null) ?? null;
  }

  async ticketKey(ticket: Pick<TicketRow, "account_id" | "ticket_number">) {
    const { data } = await this.db.from("accounts").select("ticket_key_prefix").eq("id", ticket.account_id).maybeSingle();
    const prefix = (data as { ticket_key_prefix?: string } | null)?.ticket_key_prefix || "VIR";
    return `${prefix}-${ticket.ticket_number}`;
  }

  async applyTicketStatus(ticketId: string, status: string, issueKey: string) {
    const { data, error } = await this.db.rpc("jira_apply_ticket_status", {
      p_ticket_id: ticketId,
      p_status: status,
      p_issue_key: issueKey,
    });
    if (error) fail("applyTicketStatus", error);
    return data === true;
  }

  async setTicketAssignee(ticketId: string, userId: string) {
    const { error } = await this.db.from("tickets").update({ assigned_agent_id: userId }).eq("id", ticketId);
    if (error) fail("setTicketAssignee", error);
  }

  async insertNote(input: { ticketId: string; accountId: string; body: string; jiraAuthor: string; jiraCommentId: string | null }) {
    const { data, error } = await this.db
      .from("ticket_comments")
      .insert({
        ticket_id: input.ticketId,
        account_id: input.accountId,
        author_id: null,
        body: input.body,
        mentions: [],
        source: "jira",
        jira_author: input.jiraAuthor,
        jira_comment_id: input.jiraCommentId,
      })
      .select("id")
      .single();
    if (error || !data) fail("insertNote", error);
    return (data as { id: string }).id;
  }

  async getNote(id: string) {
    const { data, error } = await this.db
      .from("ticket_comments")
      .select("id, ticket_id, account_id, author_id, body, source, jira_author, jira_comment_id, deleted_in_jira")
      .eq("id", id)
      .maybeSingle();
    if (error) fail("getNote", error);
    return (data as NoteRow | null) ?? null;
  }

  async updateNote(id: string, patch: { body?: string; deleted_in_jira?: boolean }) {
    const { error } = await this.db.from("ticket_comments").update(patch).eq("id", id);
    if (error) fail("updateNote", error);
  }

  async addActivity(input: {
    ticketId: string;
    accountId: string;
    eventType: string;
    actorId?: string | null;
    fromValue?: string | null;
    toValue?: string | null;
    detail?: string | null;
  }) {
    const { error } = await this.db.from("ticket_activity").insert({
      ticket_id: input.ticketId,
      account_id: input.accountId,
      actor_id: input.actorId ?? null,
      event_type: input.eventType,
      from_value: input.fromValue ?? null,
      to_value: input.toValue ?? null,
      detail: input.detail ?? null,
    });
    if (error) fail("addActivity", error);
  }

  async notifyTicketOwner(input: { ticket: TicketRow; type: string; title: string; body: string }) {
    const recipient = input.ticket.assigned_agent_id ?? input.ticket.created_by;
    if (!recipient) return;
    const { error } = await this.db.from("notifications").insert({
      account_id: input.ticket.account_id,
      user_id: recipient,
      type: input.type,
      ticket_id: input.ticket.id,
      contact_id: input.ticket.contact_id,
      title: input.title,
      body: input.body,
    });
    if (error) fail("notifyTicketOwner", error);
  }

  async getMapByJiraComment(linkId: string, jiraCommentId: string) {
    const { data, error } = await this.db
      .from("jira_comment_map")
      .select("*")
      .eq("link_id", linkId)
      .eq("jira_comment_id", jiraCommentId)
      .maybeSingle();
    if (error) fail("getMapByJiraComment", error);
    return (data as CommentMapRow | null) ?? null;
  }

  async getMapsForNote(noteId: string) {
    const { data, error } = await this.db.from("jira_comment_map").select("*").eq("ticket_comment_id", noteId);
    if (error) fail("getMapsForNote", error);
    return (data as CommentMapRow[]) ?? [];
  }

  async getMapsForLink(linkId: string) {
    const { data, error } = await this.db.from("jira_comment_map").select("*").eq("link_id", linkId);
    if (error) fail("getMapsForLink", error);
    return (data as CommentMapRow[]) ?? [];
  }

  async insertMap(row: Omit<CommentMapRow, "id">) {
    const { error } = await this.db.from("jira_comment_map").insert(row);
    // A concurrent worker recorded the same comment first: fine, the map is idempotent.
    if (error?.code === "23505") return false;
    if (error) fail("insertMap", error);
    return true;
  }

  async updateMap(id: string, patch: Partial<Omit<CommentMapRow, "id">>) {
    const { error } = await this.db.from("jira_comment_map").update(patch).eq("id", id);
    if (error) fail("updateMap", error);
  }

  async getContactBasics(contactId: string) {
    const { data } = await this.db.from("contacts").select("name, email").eq("id", contactId).maybeSingle();
    return (data as { name: string | null; email: string | null } | null) ?? null;
  }

  async listFieldMappings(connectionId: string) {
    const { data, error } = await this.db.from("jira_field_mappings").select("*").eq("connection_id", connectionId);
    if (error) fail("listFieldMappings", error);
    return (data as FieldMappingRow[]) ?? [];
  }

  async getFieldDefinitions(accountId: string) {
    const { data, error } = await this.db
      .from("ticket_field_definitions")
      .select("id, label, field_type, options, is_active")
      .eq("account_id", accountId);
    if (error) fail("getFieldDefinitions", error);
    return ((data as VircleFieldDef[]) ?? []).map((d) => ({ ...d, options: Array.isArray(d.options) ? d.options : [] }));
  }

  async applyTicketFields(ticketId: string, values: Record<string, unknown>) {
    const { data, error } = await this.db.rpc("jira_apply_ticket_fields", { p_ticket_id: ticketId, p_values: values });
    if (error) fail("applyTicketFields", error);
    return data === true;
  }

  async setFieldState(linkId: string, state: Record<string, FieldState>) {
    const { error } = await this.db.from("ticket_jira_links").update({ field_state: state }).eq("id", linkId);
    if (error) fail("setFieldState", error);
  }

  async getTicketAttachment(id: string) {
    const { data, error } = await this.db
      .from("ticket_attachments")
      .select("id, ticket_id, account_id, storage_path, url, filename, mime_type, size_bytes, source, jira_attachment_id")
      .eq("id", id)
      .maybeSingle();
    if (error) fail("getTicketAttachment", error);
    return (data as TicketAttachmentRow | null) ?? null;
  }

  async countTicketAttachments(ticketId: string) {
    const { count, error } = await this.db.from("ticket_attachments").select("id", { count: "exact", head: true }).eq("ticket_id", ticketId);
    if (error) fail("countTicketAttachments", error);
    return count ?? 0;
  }

  async insertTicketAttachment(input: {
    ticketId: string;
    accountId: string;
    storagePath: string;
    url: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    jiraAttachmentId: string;
  }) {
    const { data, error } = await this.db
      .from("ticket_attachments")
      .insert({
        ticket_id: input.ticketId,
        account_id: input.accountId,
        storage_path: input.storagePath,
        url: input.url,
        filename: input.filename,
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes,
        uploaded_by: null,
        source: "jira",
        jira_attachment_id: input.jiraAttachmentId,
      })
      .select("id")
      .single();
    if (error || !data) fail("insertTicketAttachment", error);
    return (data as { id: string }).id;
  }

  async deleteTicketAttachment(id: string) {
    const { error } = await this.db.from("ticket_attachments").delete().eq("id", id);
    if (error) fail("deleteTicketAttachment", error);
  }

  async listAttachmentMaps(linkId: string) {
    const { data, error } = await this.db.from("jira_attachment_map").select("*").eq("link_id", linkId);
    if (error) fail("listAttachmentMaps", error);
    return (data as AttachmentMapRow[]) ?? [];
  }

  async insertAttachmentMap(row: Omit<AttachmentMapRow, "id">) {
    const { error } = await this.db.from("jira_attachment_map").insert(row);
    // The same Jira attachment (or the same bytes on the issue) was recorded first: fine, it is idempotent.
    if (error?.code === "23505") return false;
    if (error) fail("insertAttachmentMap", error);
    return true;
  }

  async createBulkBatch(input: {
    accountId: string;
    connectionId: string;
    kind: "create" | "link";
    createdBy: string | null;
    targetIssueId?: string | null;
    targetIssueKey?: string | null;
    items: { ticketId: string; projectKey?: string | null; issueTypeId?: string | null; issueTypeName?: string | null; summary?: string | null }[];
  }) {
    const { data: batch, error } = await this.db
      .from("jira_bulk_batches")
      .insert({
        account_id: input.accountId,
        connection_id: input.connectionId,
        kind: input.kind,
        created_by: input.createdBy,
        total: input.items.length,
        target_issue_id: input.targetIssueId ?? null,
        target_issue_key: input.targetIssueKey ?? null,
      })
      .select("*")
      .single();
    if (error || !batch) fail("createBulkBatch", error);
    const b = batch as BulkBatchRow;
    const { data: items, error: iErr } = await this.db
      .from("jira_bulk_items")
      .insert(
        input.items.map((i) => ({
          batch_id: b.id,
          account_id: input.accountId,
          ticket_id: i.ticketId,
          project_key: i.projectKey ?? null,
          issue_type_id: i.issueTypeId ?? null,
          issue_type_name: i.issueTypeName ?? null,
          summary: i.summary ?? null,
        })),
      )
      .select("*");
    if (iErr || !items) {
      await this.db.from("jira_bulk_batches").delete().eq("id", b.id);
      fail("createBulkBatch items", iErr);
    }
    return { batch: b, items: items as BulkItemRow[] };
  }

  async getBulkBatch(id: string) {
    const { data, error } = await this.db.from("jira_bulk_batches").select("*").eq("id", id).maybeSingle();
    if (error) fail("getBulkBatch", error);
    return (data as BulkBatchRow | null) ?? null;
  }

  async getBulkItem(id: string) {
    const { data, error } = await this.db.from("jira_bulk_items").select("*").eq("id", id).maybeSingle();
    if (error) fail("getBulkItem", error);
    return (data as BulkItemRow | null) ?? null;
  }

  async listBulkItems(batchId: string) {
    const { data, error } = await this.db.from("jira_bulk_items").select("*").eq("batch_id", batchId).order("created_at").order("id");
    if (error) fail("listBulkItems", error);
    return (data as BulkItemRow[]) ?? [];
  }

  async updateBulkItem(id: string, patch: Partial<Pick<BulkItemRow, "status" | "issue_key" | "code" | "message">>) {
    const { error } = await this.db.from("jira_bulk_items").update(patch).eq("id", id);
    if (error) fail("updateBulkItem", error);
  }

  async notifyStalled(connectionId: string, minutes: number) {
    const { data, error } = await this.db.rpc("jira_notify_stalled", { p_connection_id: connectionId, p_minutes: Math.round(minutes) });
    if (error) fail("notifyStalled", error);
    return Number(data ?? 0);
  }

  async bumpWebhookStat(connectionId: string, kind: "signed" | "unsigned" | "rejected_unsigned") {
    // Counters are diagnostics: they never break a delivery.
    await this.db.rpc("jira_bump_webhook_stat", { p_connection_id: connectionId, p_kind: kind }).then(
      () => undefined,
      () => undefined,
    );
  }

  async userIdForJiraAccount(accountId: string, jiraAccountId: string) {
    const { data } = await this.db
      .from("jira_user_map")
      .select("user_id")
      .eq("account_id", accountId)
      .eq("jira_account_id", jiraAccountId)
      .maybeSingle();
    return (data as { user_id?: string } | null)?.user_id ?? null;
  }

  async jiraAccountForUser(accountId: string, userId: string) {
    const { data } = await this.db
      .from("jira_user_map")
      .select("jira_account_id")
      .eq("account_id", accountId)
      .eq("user_id", userId)
      .maybeSingle();
    return (data as { jira_account_id?: string } | null)?.jira_account_id ?? null;
  }

  async memberName(userId: string) {
    const { data } = await this.db.from("profiles").select("full_name, email").eq("user_id", userId).maybeSingle();
    const p = data as { full_name?: string | null; email?: string | null } | null;
    return p?.full_name?.trim() || p?.email || null;
  }

  async listUserMap(accountId: string) {
    const { data, error } = await this.db.from("jira_user_map").select("*").eq("account_id", accountId);
    if (error) fail("listUserMap", error);
    return (data as UserMapRow[]) ?? [];
  }

  async enqueue(input: {
    accountId: string;
    connectionId: string;
    kind: JobRow["kind"];
    payload: Record<string, unknown>;
    dedupeKey?: string;
    delaySeconds?: number;
  }) {
    const { error } = await this.db.rpc("jira_enqueue_job", {
      p_account_id: input.accountId,
      p_connection_id: input.connectionId,
      p_kind: input.kind,
      p_payload: input.payload,
      p_dedupe_key: input.dedupeKey ?? null,
      p_delay_seconds: input.delaySeconds ?? 0,
    });
    if (error) fail("enqueue", error);
  }

  async claimJobs(limit: number, worker: string, leaseSeconds: number) {
    const { data, error } = await this.db.rpc("jira_claim_jobs", { p_limit: limit, p_worker: worker, p_lease_seconds: leaseSeconds });
    if (error) fail("claimJobs", error);
    return (data as JobRow[]) ?? [];
  }

  async finishJob(id: string, worker: string, outcome: "ok" | "retry" | "dead", error: string | null, retrySeconds: number) {
    const { data, error: err } = await this.db.rpc("jira_finish_job", {
      p_id: id,
      p_worker: worker,
      p_outcome: outcome,
      p_error: error,
      p_retry_seconds: retrySeconds,
    });
    if (err) fail("finishJob", err);
    return String(data ?? "");
  }

  async prune() {
    const { data, error } = await this.db.rpc("jira_prune");
    if (error) fail("prune", error);
    return Number(data ?? 0);
  }

  async logEvent(e: SyncEventInput) {
    // Diagnostics must never break the work they describe.
    await this.db
      .from("jira_sync_events")
      .insert({
        account_id: e.accountId,
        connection_id: e.connectionId,
        link_id: e.linkId ?? null,
        level: e.level,
        kind: e.kind,
        message: e.message.slice(0, 500),
        details: e.details ?? null,
      })
      .then(
        () => undefined,
        () => undefined,
      );
  }

  async audit(input: {
    accountId: string;
    actorId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    label: string;
    summary?: Record<string, unknown> | null;
  }) {
    const { error } = await this.db.rpc("jira_audit", {
      p_account_id: input.accountId,
      p_actor: input.actorId,
      p_action: input.action,
      p_entity_type: input.entityType,
      p_entity_id: input.entityId,
      p_label: input.label,
      p_summary: input.summary ?? null,
    });
    // The audit log is best effort: a failure is logged, never thrown into the user's action.
    if (error) console.error("[jira] audit write failed:", error.message);
  }
}
