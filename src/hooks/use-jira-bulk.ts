"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";

import { jiraRequest, type JiraApiResult, type JiraNamed } from "./use-ticket-jira";

// ============================================================
// Bulk Jira actions on the tickets list (Create Jira issues, Link to Jira
// issue). The work is queued on the server (jira_sync_jobs); this hook only
// starts it and reads the progress. See src/app/api/integrations/jira/bulk.
// ============================================================

export const MAX_BULK_TICKETS = 25;

export interface BulkProposal {
  ticketId: string;
  ticketKey: string;
  subject: string;
  projectKey: string;
  issueTypeId: string;
  issueTypeName: string | null;
  summary: string;
  canCreate: boolean;
  /** link_limit | unsupported_fields | required_fields | not_found */
  reason?: string;
  fields?: string[];
}

export interface BulkReview {
  project: string;
  issueType: JiraNamed;
  issueTypes: JiraNamed[];
  proposals: BulkProposal[];
}

export type BulkItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface BulkProgress {
  batchId: string;
  kind: "create" | "link";
  total: number;
  counts: Record<BulkItemStatus, number>;
  finished: boolean;
  targetIssueKey: string | null;
  items: { id: string; ticket_id: string; status: BulkItemStatus; issue_key: string | null; code: string | null; message: string | null; summary: string | null; project_key: string | null }[];
}

export const bulkApi = {
  review: (ticketIds: string[], project?: string, issueTypeId?: string) =>
    jiraRequest<BulkReview>("bulk", { method: "POST", body: { action: "review", ticketIds, ...(project ? { projectKey: project } : {}), ...(issueTypeId ? { issueTypeId } : {}) } }),
  create: (items: { ticketId: string; projectKey: string; issueTypeId: string; issueTypeName?: string | null; summary?: string }[]) =>
    jiraRequest<{ batchId: string; total: number }>("bulk", { method: "POST", body: { action: "create", items } }),
  link: (ticketIds: string[], reference: string) =>
    jiraRequest<{ batchId: string; total: number; issueKey: string }>("bulk", { method: "POST", body: { action: "link", ticketIds, reference } }),
  progress: (batchId: string) => jiraRequest<BulkProgress>(`bulk?batch=${encodeURIComponent(batchId)}`),
};

/** Poll a batch until every item settles (or `stopAfterMs`), every two seconds. */
export function useBulkProgress(batchId: string | null, opts: { intervalMs?: number; stopAfterMs?: number } = {}) {
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(0);

  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    started.current = Date.now();
    const tick = async () => {
      const r: JiraApiResult<BulkProgress> = await bulkApi.progress(batchId);
      if (cancelled) return;
      if (!r.ok) {
        setError(r.code);
      } else {
        setError(null);
        setProgress(r.data);
        if (r.data.finished) return;
      }
      if (Date.now() - started.current < (opts.stopAfterMs ?? 10 * 60_000)) timer = setTimeout(() => void tick(), opts.intervalMs ?? 2000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId, opts.intervalMs, opts.stopAfterMs]);

  return { progress: batchId ? progress : null, error };
}

/**
 * Is a Jira connection active in this workspace, and at which site? (The
 * cached row, read through RLS: members may read jira_connections' safe
 * columns.) The bulk buttons only show when it is.
 */
export function useJiraConnected(): { active: boolean; siteUrl: string | null } {
  const [state, setState] = useState<{ active: boolean; siteUrl: string | null }>({ active: false, siteUrl: null });
  const load = useCallback(async () => {
    const { data } = await createClient().from("jira_connections").select("status, site_url").limit(1);
    const row = ((data as { status: string; site_url: string }[] | null) ?? [])[0];
    setState({ active: row?.status === "active", siteUrl: row?.site_url ?? null });
  }, []);
  useEffect(() => {
    // Loads over the network; the state is set after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  return state;
}
