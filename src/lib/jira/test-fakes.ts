// ============================================================
// Test doubles for the Jira sync: an in-memory `JiraStore` and a scriptable
// client. Used only by *.test.ts files; nothing in the app imports this.
// ============================================================

import type {
  CommentMapRow,
  JiraStore,
  JobRow,
  NoteRow,
  SyncEventInput,
  TicketRow,
  UserMapRow,
} from "./store";
import { DEFAULT_JIRA_SETTINGS, type JiraConnectionRow, type JiraIssue, type JiraSettings, type TicketJiraLinkRow } from "./types";
import type { SyncContext } from "./sync";

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

export function connectionRow(over: Partial<JiraConnectionRow> = {}): JiraConnectionRow {
  return {
    id: "conn-1",
    account_id: "acct-1",
    cloud_id: "11111111-2222-4333-8444-555555555555",
    site_url: "https://acme.atlassian.net",
    site_name: "Acme",
    connected_by: "user-admin",
    jira_account_id: "acct-bot",
    jira_display_name: "Vircle Integration",
    status: "active",
    status_reason: null,
    token_expires_at: null,
    webhook_ids: [],
    webhook_expires_at: null,
    webhook_checked_at: null,
    last_catchup_at: null,
    last_report_at: null,
    settings: {},
    rate_limit: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

export function linkRow(over: Partial<TicketJiraLinkRow> = {}): TicketJiraLinkRow {
  return {
    id: uid("link"),
    account_id: "acct-1",
    ticket_id: "t-1",
    connection_id: "conn-1",
    issue_id: "10001",
    issue_key: "ENG-1",
    project_key: "ENG",
    project_name: "Engineering",
    issue_type: "Bug",
    summary: "Login fails",
    status_id: "1",
    status_name: "To Do",
    status_category: "new",
    resolution: null,
    priority_name: "High",
    assignee_account_id: null,
    assignee_name: null,
    reporter_name: "Vircle Integration",
    issue_url: "https://acme.atlassian.net/browse/ENG-1",
    jira_updated_at: "2026-09-20T09:00:00.000Z",
    last_synced_at: "2026-09-20T09:00:00.000Z",
    sync_state: "ok",
    sync_error: null,
    last_written: {},
    last_push: null,
    remote_link_id: null,
    linked_by: "user-agent",
    last_resync_at: null,
    created_at: "2026-09-20T09:00:00.000Z",
    updated_at: "2026-09-20T09:00:00.000Z",
    ...over,
  };
}

export function ticketRow(over: Partial<TicketRow> = {}): TicketRow {
  return {
    id: "t-1",
    account_id: "acct-1",
    ticket_number: 12,
    contact_id: "c-1",
    subject: "Login fails on Safari",
    description: "Customer cannot sign in.",
    category: "bug",
    status: "open",
    priority: "high",
    assigned_agent_id: "user-agent",
    created_by: "user-agent",
    ...over,
  };
}

export function issue(over: { id?: string; key?: string; status?: { id: string; name: string; category: string }; updated?: string; assignee?: { accountId: string; displayName: string } | null } = {}): JiraIssue {
  const st = over.status ?? { id: "1", name: "To Do", category: "new" };
  return {
    id: over.id ?? "10001",
    key: over.key ?? "ENG-1",
    fields: {
      summary: "Login fails",
      status: { id: st.id, name: st.name, statusCategory: { key: st.category } },
      assignee: over.assignee === undefined ? null : over.assignee,
      reporter: { accountId: "acct-bot", displayName: "Vircle Integration" },
      priority: { id: "2", name: "High" },
      resolution: null,
      issuetype: { id: "10004", name: "Bug" },
      project: { id: "10000", key: "ENG", name: "Engineering" },
      updated: over.updated ?? "2026-09-20T10:00:00.000+0000",
    },
  };
}

/** An in-memory JiraStore. Every table is a plain array you can inspect. */
export class MemoryStore implements JiraStore {
  connections: JiraConnectionRow[] = [connectionRow()];
  links: TicketJiraLinkRow[] = [];
  tickets: TicketRow[] = [ticketRow()];
  notes: (NoteRow & { edited?: boolean })[] = [];
  maps: CommentMapRow[] = [];
  userMap: UserMapRow[] = [];
  jobs: (Omit<JobRow, "status"> & { status: string; dedupe: string | null })[] = [];
  events: SyncEventInput[] = [];
  activity: { ticketId: string; eventType: string; toValue?: string | null; detail?: string | null; actorId?: string | null }[] = [];
  notifications: { type: string; ticketId: string; body: string }[] = [];
  audits: { action: string; entityType: string; label: string; summary?: Record<string, unknown> | null }[] = [];
  appliedStatuses: { ticketId: string; status: string; key: string }[] = [];
  assigneeChanges: { ticketId: string; userId: string }[] = [];
  names: Record<string, string> = { "user-agent": "Maya", "user-admin": "Ada" };
  reauth: { id: string; reason: string }[] = [];

  async getConnection(id: string) {
    return this.connections.find((c) => c.id === id) ?? null;
  }
  async getConnectionByAccount(accountId: string) {
    return this.connections.find((c) => c.account_id === accountId) ?? null;
  }
  async listActiveConnections() {
    return this.connections.filter((c) => c.status === "active");
  }
  async updateConnection(id: string, patch: Record<string, unknown>) {
    Object.assign(this.connections.find((c) => c.id === id)!, patch);
  }
  async markReauth(connectionId: string, reason: string) {
    this.reauth.push({ id: connectionId, reason });
    const c = this.connections.find((x) => x.id === connectionId);
    if (c) c.status = "reauth_required";
  }

  async getLink(id: string) {
    return this.links.find((l) => l.id === id) ?? null;
  }
  async linksForIssue(connectionId: string, issueId: string) {
    return this.links.filter((l) => l.connection_id === connectionId && l.issue_id === issueId);
  }
  async linksForTicket(ticketId: string) {
    return this.links.filter((l) => l.ticket_id === ticketId);
  }
  async linksForConnection(connectionId: string, states?: string[]) {
    return this.links.filter((l) => l.connection_id === connectionId && (!states || states.includes(l.sync_state)));
  }
  async insertLink(row: Record<string, unknown>) {
    const dup = this.links.some((l) => l.ticket_id === row.ticket_id && l.issue_id === row.issue_id);
    if (dup) throw Object.assign(new Error("duplicate"), { code: "23505" });
    if (this.links.filter((l) => l.ticket_id === row.ticket_id).length >= 5) {
      throw Object.assign(new Error("limit"), { code: "23514", hint: "jira_link_limit" });
    }
    const l = linkRow({ ...(row as Partial<TicketJiraLinkRow>), id: uid("link") });
    this.links.push(l);
    return l;
  }
  async updateLink(id: string, patch: Record<string, unknown>) {
    Object.assign(this.links.find((l) => l.id === id)!, patch);
  }
  async deleteLink(id: string) {
    this.links = this.links.filter((l) => l.id !== id);
    this.maps = this.maps.filter((m) => m.link_id !== id);
  }

  async getTicket(id: string) {
    return this.tickets.find((t) => t.id === id) ?? null;
  }
  async ticketKey(ticket: Pick<TicketRow, "ticket_number">) {
    return `VIR-${ticket.ticket_number}`;
  }
  async applyTicketStatus(ticketId: string, status: string, key: string) {
    const t = this.tickets.find((x) => x.id === ticketId);
    if (!t || t.status === status) return false;
    t.status = status;
    this.appliedStatuses.push({ ticketId, status, key });
    return true;
  }
  async setTicketAssignee(ticketId: string, userId: string) {
    this.tickets.find((t) => t.id === ticketId)!.assigned_agent_id = userId;
    this.assigneeChanges.push({ ticketId, userId });
  }
  async insertNote(input: { ticketId: string; accountId: string; body: string; jiraAuthor: string; jiraCommentId: string | null }) {
    const id = uid("note");
    this.notes.push({
      id,
      ticket_id: input.ticketId,
      account_id: input.accountId,
      author_id: null,
      body: input.body,
      source: "jira",
      jira_author: input.jiraAuthor,
      jira_comment_id: input.jiraCommentId,
      deleted_in_jira: false,
    });
    return id;
  }
  async getNote(id: string) {
    return this.notes.find((n) => n.id === id) ?? null;
  }
  async updateNote(id: string, patch: { body?: string; deleted_in_jira?: boolean }) {
    Object.assign(this.notes.find((n) => n.id === id)!, patch);
  }
  /** A note written by a person in Vircle (what an agent types). */
  addAgentNote(body: string, over: Partial<NoteRow> = {}): NoteRow {
    const n: NoteRow = {
      id: uid("note"),
      ticket_id: "t-1",
      account_id: "acct-1",
      author_id: "user-agent",
      body,
      source: "vircle",
      jira_author: null,
      jira_comment_id: null,
      deleted_in_jira: false,
      ...over,
    };
    this.notes.push(n);
    return n;
  }
  async addActivity(input: { ticketId: string; accountId: string; eventType: string; actorId?: string | null; fromValue?: string | null; toValue?: string | null; detail?: string | null }) {
    this.activity.push({ ticketId: input.ticketId, eventType: input.eventType, toValue: input.toValue, detail: input.detail, actorId: input.actorId });
  }
  async notifyTicketOwner(input: { ticket: TicketRow; type: string; title: string; body: string }) {
    this.notifications.push({ type: input.type, ticketId: input.ticket.id, body: input.body });
  }

  async getMapByJiraComment(linkId: string, jiraCommentId: string) {
    return this.maps.find((m) => m.link_id === linkId && m.jira_comment_id === jiraCommentId) ?? null;
  }
  async getMapsForNote(noteId: string) {
    return this.maps.filter((m) => m.ticket_comment_id === noteId);
  }
  async getMapsForLink(linkId: string) {
    return this.maps.filter((m) => m.link_id === linkId);
  }
  async insertMap(row: Omit<CommentMapRow, "id">) {
    if (this.maps.some((m) => m.link_id === row.link_id && m.jira_comment_id === row.jira_comment_id)) return false;
    this.maps.push({ ...row, id: uid("map") });
    return true;
  }
  async updateMap(id: string, patch: Partial<Omit<CommentMapRow, "id">>) {
    Object.assign(this.maps.find((m) => m.id === id)!, patch);
  }

  async userIdForJiraAccount(accountId: string, jiraAccountId: string) {
    return this.userMap.find((u) => u.account_id === accountId && u.jira_account_id === jiraAccountId)?.user_id ?? null;
  }
  async jiraAccountForUser(accountId: string, userId: string) {
    return this.userMap.find((u) => u.account_id === accountId && u.user_id === userId)?.jira_account_id ?? null;
  }
  async memberName(userId: string) {
    return this.names[userId] ?? null;
  }
  async listUserMap(accountId: string) {
    return this.userMap.filter((u) => u.account_id === accountId);
  }

  async enqueue(input: { accountId: string; connectionId: string; kind: JobRow["kind"]; payload: Record<string, unknown>; dedupeKey?: string; delaySeconds?: number }) {
    const existing = input.dedupeKey ? this.jobs.find((j) => j.status === "pending" && j.dedupe === input.dedupeKey && j.connection_id === input.connectionId) : undefined;
    if (existing) {
      existing.payload = input.payload;
      return;
    }
    this.jobs.push({
      id: uid("job"),
      account_id: input.accountId,
      connection_id: input.connectionId,
      kind: input.kind,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      max_attempts: 6,
      dedupe: input.dedupeKey ?? null,
    });
  }
  async claimJobs(limit: number, worker: string) {
    const due = this.jobs.filter((j) => j.status === "pending").slice(0, limit);
    for (const j of due) {
      j.status = "running";
      j.attempts += 1;
      (j as { worker?: string }).worker = worker;
    }
    return due.map((j) => ({ ...j })) as JobRow[];
  }
  async finishJob(id: string, worker: string, outcome: "ok" | "retry" | "dead", error: string | null) {
    const j = this.jobs.find((x) => x.id === id)!;
    if (outcome === "ok") j.status = "done";
    else if (outcome === "retry" && j.attempts < j.max_attempts) j.status = "pending-later";
    else j.status = "dead";
    (j as { last_error?: string | null }).last_error = error;
    return j.status === "done" ? "done" : j.status === "dead" ? "dead" : "retry";
  }
  async prune() {
    return 0;
  }
  async logEvent(e: SyncEventInput) {
    this.events.push(e);
  }
  async audit(input: { accountId: string; actorId: string | null; action: string; entityType: string; entityId: string | null; label: string; summary?: Record<string, unknown> | null }) {
    this.audits.push({ action: input.action, entityType: input.entityType, label: input.label, summary: input.summary });
  }
}

/** A client whose methods are vi.fn-like recorders with scripted answers. */
export interface FakeClientScript {
  getIssue?: (idOrKey: string) => Promise<JiraIssue | null>;
  listComments?: () => Promise<{ comments?: unknown[]; total?: number }>;
  getTransitions?: () => Promise<{ transitions?: unknown[] }>;
  doTransition?: (id: string, transitionId: string, fields?: Record<string, unknown>) => Promise<unknown>;
  addComment?: (idOrKey: string, body: unknown, props?: unknown) => Promise<{ id: string; author?: { accountId: string }; updated?: string } | null>;
  updateComment?: (idOrKey: string, commentId: string, body: unknown) => Promise<unknown>;
  upsertRemoteLink?: (idOrKey: string, link: unknown) => Promise<{ id: number } | null>;
  listCreateFields?: () => Promise<{ fields?: unknown[] }>;
  createIssue?: (fields: Record<string, unknown>) => Promise<{ id: string; key: string } | null>;
  bulkFetch?: (ids: string[]) => Promise<JiraIssue[]>;
  searchIssues?: (a: unknown) => Promise<{ issues?: { id: string }[]; nextPageToken?: string } | null>;
}

export function fakeClient(script: FakeClientScript = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = <T>(method: string, fn: ((...a: never[]) => Promise<T>) | undefined, fallback: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return fn ? (fn as (...a: unknown[]) => Promise<T>)(...args) : fallback;
    };
  const client = {
    getIssue: rec("getIssue", script.getIssue as never, null as JiraIssue | null),
    listComments: rec("listComments", script.listComments as never, { comments: [] as unknown[], total: 0 }),
    getTransitions: rec("getTransitions", script.getTransitions as never, { transitions: [] as unknown[] }),
    doTransition: rec("doTransition", script.doTransition as never, null as unknown),
    addComment: rec("addComment", script.addComment as never, { id: "9001" } as { id: string } | null),
    updateComment: rec("updateComment", script.updateComment as never, null as unknown),
    upsertRemoteLink: rec("upsertRemoteLink", script.upsertRemoteLink as never, { id: 5 } as { id: number } | null),
    listCreateFields: rec("listCreateFields", script.listCreateFields as never, { fields: [] as unknown[] }),
    createIssue: rec("createIssue", script.createIssue as never, { id: "10099", key: "ENG-99" } as { id: string; key: string } | null),
    bulkFetch: rec("bulkFetch", script.bulkFetch as never, [] as JiraIssue[]),
    searchIssues: rec("searchIssues", script.searchIssues as never, { issues: [] as { id: string }[] } as { issues?: { id: string }[]; nextPageToken?: string } | null),
  };
  return { client: client as unknown as SyncContext["client"], calls };
}

export function makeContext(store: MemoryStore, client: SyncContext["client"], settings: Partial<JiraSettings> = {}, over: Partial<SyncContext> = {}): SyncContext {
  const merged = {
    ...DEFAULT_JIRA_SETTINGS,
    ...settings,
    direction: { ...DEFAULT_JIRA_SETTINGS.direction, ...(settings.direction ?? {}) },
    mapping: { ...DEFAULT_JIRA_SETTINGS.mapping, ...(settings.mapping ?? {}) },
    projects: { ...DEFAULT_JIRA_SETTINGS.projects, ...(settings.projects ?? {}) },
    privacy: { ...DEFAULT_JIRA_SETTINGS.privacy, ...(settings.privacy ?? {}) },
  } as JiraSettings;
  return {
    store,
    client,
    connection: store.connections[0],
    settings: merged,
    appUrl: "https://crm.example.com",
    now: () => Date.parse("2026-09-20T10:05:00Z"),
    ...over,
  };
}
