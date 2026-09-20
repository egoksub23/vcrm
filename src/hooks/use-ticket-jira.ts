"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { normalizeSettings } from "@/lib/jira/settings";
import {
  MAX_LINKS_PER_TICKET,
  type JiraSettings,
  type SyncState,
  type TicketJiraLinkRow,
} from "@/lib/jira/types";
import { normalizeCategory, safeHttpUrl, type JiraChip } from "@/lib/tickets/jira-ui";

// ============================================================
// The ticket side of the Jira link: cached rows only. Rendering a ticket
// never calls Jira; every button calls one of the API routes under
// /api/integrations/jira and gets back a typed result (never a throw).
// ============================================================

const API = "/api/integrations/jira";

/** A failed API call: a stable code (see Jira.errors) plus whatever detail Jira gave. */
export interface JiraApiError {
  ok: false;
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
  /** jira_rejected: what Jira said, per field and in general. */
  messages?: string[];
  fieldErrors?: Record<string, string>;
  /** unsupported_fields / missing_fields: the fields named. */
  fields?: string[];
}
export type JiraApiResult<T> = { ok: true; status: number; data: T } | JiraApiError;

export async function jiraRequest<T>(path: string, init?: { method?: string; body?: unknown }): Promise<JiraApiResult<T>> {
  try {
    const res = await fetch(`${API}/${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, status: res.status, data: (body ?? {}) as T };
    const detail = body?.detail as { fields?: unknown } | undefined;
    const fields = Array.isArray(detail?.fields) ? detail.fields.filter((f): f is string => typeof f === "string") : undefined;
    return {
      ok: false,
      status: res.status,
      code: typeof body?.error === "string" ? body.error : res.status === 429 ? "jira_rate_limited" : res.status === 403 ? "forbidden" : "generic",
      message: typeof body?.message === "string" ? body.message : "",
      retryAfterSeconds: typeof body?.retry_after_seconds === "number" ? body.retry_after_seconds : undefined,
      messages: Array.isArray(body?.messages) ? (body.messages as unknown[]).filter((m): m is string => typeof m === "string") : undefined,
      fieldErrors:
        body?.fieldErrors && typeof body.fieldErrors === "object"
          ? Object.fromEntries(Object.entries(body.fieldErrors as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][])
          : undefined,
      fields,
    };
  } catch {
    return { ok: false, status: 0, code: "network", message: "" };
  }
}

// ---- API shapes ----------------------------------------------------------------

export interface JiraTransition {
  id: string;
  name: string;
  to: string | null;
  category: string | null;
  blocked: boolean;
}

export interface JiraShareResult {
  linkId: string;
  key: string;
  ok: boolean;
  /** shared | already | an error code */
  code: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}
export interface JiraNamed {
  id: string;
  name: string;
}
export interface JiraIssueHit {
  id: string;
  key: string;
  summary: string;
  status: string | null;
  category: string | null;
  project: string | null;
  type: string | null;
}
export interface JiraUserHit {
  accountId: string;
  displayName: string;
  email: string | null;
}

export interface JiraCreateChoices {
  projectKey: string;
  issueTypeId: string;
  issueTypeName?: string;
  priorityName?: string;
  extraLabels?: string[];
  assigneeAccountId?: string;
}

export type JiraFieldKind = "text" | "textarea" | "select" | "multiselect" | "user" | "labels" | "number" | "date";

export interface JiraRequiredField {
  id: string;
  name: string;
  kind: JiraFieldKind;
  options: JiraNamed[];
}

export interface JiraCreatePreview {
  preview: {
    project: string;
    issueType: string | null;
    summary: string;
    descriptionText: string;
    descriptionTruncated: boolean;
    priority: string | null;
    labels: string[];
    assigneeAccountId: string | null;
    /** Whether the customer's name and email are part of what is sent. */
    includesCustomer: boolean;
    extraFields: Record<string, unknown>;
  };
  required: { ask: JiraRequiredField[]; unsupported: string[] };
  previewRequired: boolean;
}

/** Thin, typed wrappers over the routes. None of them throws. */
export const jiraApi = {
  syncNow: (linkId: string) =>
    jiraRequest<{ ok: boolean; broken: string | null }>(`links/${encodeURIComponent(linkId)}/sync`, { method: "POST", body: {} }),
  unlink: (linkId: string) => jiraRequest<{ ok: boolean }>(`links/${encodeURIComponent(linkId)}`, { method: "DELETE" }),
  listTransitions: (linkId: string) => jiraRequest<{ transitions: JiraTransition[] }>(`links/${encodeURIComponent(linkId)}/transitions`),
  transition: (linkId: string, transitionId: string) =>
    jiraRequest<{ ok: boolean }>(`links/${encodeURIComponent(linkId)}/transition`, { method: "POST", body: { transitionId } }),
  commentInJira: (linkId: string, text: string) =>
    jiraRequest<{ noteId: string; results: JiraShareResult[] }>(`links/${encodeURIComponent(linkId)}/comment`, { method: "POST", body: { text } }),
  shareNote: (noteId: string, linkId?: string) =>
    jiraRequest<{ results?: JiraShareResult[]; queued?: boolean }>("comments/share", { method: "POST", body: linkId ? { noteId, linkId } : { noteId } }),
  projects: (q?: string) => jiraRequest<{ projects: JiraProject[] }>(`metadata?kind=projects${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  issueTypes: (project: string) => jiraRequest<{ issueTypes: JiraNamed[] }>(`metadata?kind=issue_types&project=${encodeURIComponent(project)}`),
  priorities: () => jiraRequest<{ priorities: JiraNamed[] }>("metadata?kind=priorities"),
  searchIssues: (q: string) => jiraRequest<{ issues: JiraIssueHit[] }>(`issues/search?q=${encodeURIComponent(q)}`),
  searchUsers: (q: string, project?: string) =>
    jiraRequest<{ users: JiraUserHit[] }>(`users/search?q=${encodeURIComponent(q)}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
  previewCreate: (ticketId: string, choices: JiraCreateChoices) =>
    jiraRequest<JiraCreatePreview>("create", { method: "POST", body: { ticketId, preview: true, choices } }),
  createIssue: (ticketId: string, choices: JiraCreateChoices, fieldValues: Record<string, unknown>) =>
    jiraRequest<{ link: TicketJiraLinkRow }>("create", { method: "POST", body: { ticketId, choices, fieldValues } }),
  linkIssue: (ticketId: string, reference: string) =>
    jiraRequest<{ link: TicketJiraLinkRow }>("links", { method: "POST", body: { ticketId, reference } }),
};

// ---- The hook -------------------------------------------------------------------

/** The safe view of the workspace's Jira connection (no token exists in this table). */
export interface JiraConnectionSummary {
  id: string;
  status: "active" | "reauth_required" | "revoked";
  statusReason: string | null;
  siteName: string | null;
  siteUrl: string;
  settings: JiraSettings;
}

interface ConnectionRow {
  id: string;
  status: JiraConnectionSummary["status"];
  status_reason: string | null;
  site_name: string | null;
  site_url: string;
  settings: unknown;
}

export interface TicketJira {
  loading: boolean;
  links: TicketJiraLinkRow[];
  connection: JiraConnectionSummary | null;
  /** The connection is active: create / link / sync can work. */
  connected: boolean;
  /** The connection lost its authorisation and must be reconnected in Settings. */
  needsReconnect: boolean;
  /** Settings > Jira: notes may be shared with Jira. */
  commentsToJira: boolean;
  /** At least one link is healthy (sync_state ok): a note can be shared. */
  hasOkLink: boolean;
  atLimit: boolean;
  /** Ids of this ticket's notes that were already posted to Jira. */
  sharedNoteIds: Set<string>;
  reload: () => Promise<void>;
  syncNow: (linkId: string) => Promise<JiraApiResult<{ ok: boolean; broken: string | null }>>;
  unlink: (linkId: string) => Promise<JiraApiResult<{ ok: boolean }>>;
  listTransitions: (linkId: string) => Promise<JiraApiResult<{ transitions: JiraTransition[] }>>;
  transition: (linkId: string, transitionId: string) => Promise<JiraApiResult<{ ok: boolean }>>;
  commentInJira: (linkId: string, text: string) => Promise<JiraApiResult<{ noteId: string; results: JiraShareResult[] }>>;
  shareNote: (noteId: string, linkId?: string) => Promise<JiraApiResult<{ results?: JiraShareResult[]; queued?: boolean }>>;
}

/**
 * The Jira state of one ticket: its links (live over realtime), the
 * workspace's connection summary, and which notes were already shared.
 * Reads only cached rows through the browser client (RLS: workspace members);
 * Jira itself is only called by the action functions.
 */
export function useTicketJira(ticketId: string | null): TicketJira {
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [links, setLinks] = useState<TicketJiraLinkRow[]>([]);
  const [connection, setConnection] = useState<JiraConnectionSummary | null>(null);
  const [sharedNoteIds, setSharedNoteIds] = useState<Set<string>>(() => new Set());

  const idRef = useRef(ticketId);
  useEffect(() => {
    idRef.current = ticketId;
  }, [ticketId]);

  const load = useCallback(async (id: string, part: "all" | "links" = "all") => {
    const supabase = createClient();
    const linkRes = await supabase.from("ticket_jira_links").select("*").eq("ticket_id", id).order("created_at", { ascending: true });
    const rows = (linkRes.data as TicketJiraLinkRow[] | null) ?? [];
    let conn: JiraConnectionSummary | null | undefined;
    if (part === "all") {
      const connRes = await supabase
        .from("jira_connections")
        .select("id, status, status_reason, site_name, site_url, settings")
        .limit(1);
      const c = ((connRes.data as ConnectionRow[] | null) ?? [])[0];
      conn = c
        ? { id: c.id, status: c.status, statusReason: c.status_reason, siteName: c.site_name, siteUrl: c.site_url, settings: normalizeSettings(c.settings) }
        : null;
    }
    let shared = new Set<string>();
    if (rows.length > 0) {
      const mapRes = await supabase
        .from("jira_comment_map")
        .select("ticket_comment_id")
        .in("link_id", rows.map((r) => r.id))
        .eq("origin", "vircle")
        .not("ticket_comment_id", "is", null);
      shared = new Set(((mapRes.data as { ticket_comment_id: string }[] | null) ?? []).map((r) => r.ticket_comment_id));
    }
    if (idRef.current !== id) return;
    setLinks(rows);
    setSharedNoteIds(shared);
    if (conn !== undefined) setConnection(conn);
    setLoadedId(id);
  }, []);

  useEffect(() => {
    if (!ticketId) return;
    // Loads over the network; state is set after the awaits, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ticketId);
  }, [ticketId, load]);

  useEffect(() => {
    if (!ticketId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`ticket-jira-${ticketId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "ticket_jira_links", filter: `ticket_id=eq.${ticketId}` }, () => {
        void load(ticketId, "links");
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [ticketId, load]);

  const reload = useCallback(async () => {
    if (idRef.current) await load(idRef.current);
  }, [load]);

  const afterWrite = useCallback(
    async <T,>(result: Promise<JiraApiResult<T>>): Promise<JiraApiResult<T>> => {
      const r = await result;
      // Whatever happened, the cached rows may have changed (a broken link, a new status).
      if (idRef.current) void load(idRef.current);
      return r;
    },
    [load],
  );

  const syncNow = useCallback((linkId: string) => afterWrite(jiraApi.syncNow(linkId)), [afterWrite]);
  const unlink = useCallback((linkId: string) => afterWrite(jiraApi.unlink(linkId)), [afterWrite]);
  const transition = useCallback((linkId: string, transitionId: string) => afterWrite(jiraApi.transition(linkId, transitionId)), [afterWrite]);
  const commentInJira = useCallback((linkId: string, text: string) => afterWrite(jiraApi.commentInJira(linkId, text)), [afterWrite]);
  const shareNote = useCallback((noteId: string, linkId?: string) => afterWrite(jiraApi.shareNote(noteId, linkId)), [afterWrite]);
  const listTransitions = useCallback((linkId: string) => jiraApi.listTransitions(linkId), []);

  const loading = !!ticketId && loadedId !== ticketId;
  const connected = connection?.status === "active";
  const needsReconnect = connection?.status === "reauth_required";

  return useMemo(
    () => ({
      loading,
      links,
      connection,
      connected,
      needsReconnect,
      commentsToJira: connection?.settings.direction.comments_to_jira ?? false,
      hasOkLink: links.some((l) => l.sync_state === "ok"),
      atLimit: links.length >= MAX_LINKS_PER_TICKET,
      sharedNoteIds,
      reload,
      syncNow,
      unlink,
      listTransitions,
      transition,
      commentInJira,
      shareNote,
    }),
    [loading, links, connection, connected, needsReconnect, sharedNoteIds, reload, syncNow, unlink, listTransitions, transition, commentInJira, shareNote],
  );
}

// ---- Chips for board cards and list rows --------------------------------------------

interface ChipRow {
  ticket_id: string;
  issue_key: string;
  status_category: string | null;
  issue_url: string | null;
  sync_state: SyncState;
  created_at: string;
}

const CHIP_BATCH = 100;

/**
 * The Jira keys linked to many tickets at once (one query per 100 ids), for
 * board cards and list rows. Cached rows only; kept fresh over realtime.
 */
export function useJiraLinkChips(ticketIds: readonly string[]): Record<string, JiraChip[]> {
  const [chips, setChips] = useState<Record<string, JiraChip[]>>({});
  // A stable key: the same set of ids in any order asks once.
  const idKey = useMemo(() => [...new Set(ticketIds)].sort().join(","), [ticketIds]);

  const fetchChips = useCallback(async (key: string) => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setChips((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const supabase = createClient();
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += CHIP_BATCH) batches.push(ids.slice(i, i + CHIP_BATCH));
    const results = await Promise.all(
      batches.map((batch) =>
        supabase
          .from("ticket_jira_links")
          .select("ticket_id, issue_key, status_category, issue_url, sync_state, created_at")
          .in("ticket_id", batch)
          .order("created_at", { ascending: true }),
      ),
    );
    const next: Record<string, JiraChip[]> = {};
    for (const res of results) {
      for (const r of (res.data as ChipRow[] | null) ?? []) {
        (next[r.ticket_id] ??= []).push({
          key: r.issue_key,
          category: r.status_category ? normalizeCategory(r.status_category) : null,
          url: safeHttpUrl(r.issue_url),
          state: r.sync_state,
        });
      }
    }
    setChips(next);
  }, []);

  useEffect(() => {
    void fetchChips(idKey);
  }, [idKey, fetchChips]);

  useEffect(() => {
    if (!idKey) return;
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(`jira-chips-${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "ticket_jira_links" }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void fetchChips(idKey), 400);
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [idKey, fetchChips]);

  return chips;
}
