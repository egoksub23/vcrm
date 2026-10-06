"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { mergeKeysOf } from "@/lib/sign/client/layout";
import { nextPollMs } from "@/lib/sign/client/bulk";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { roleInfos } from "@/lib/sign/bulk/plan";
import type { BulkJobView, BulkRoleInfo, BulkRowView } from "@/lib/sign/bulk/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignRole } from "@/lib/sign/types";
import { createClient } from "@/lib/supabase/client";

export interface TemplateFacts {
  roles: BulkRoleInfo[];
  mergeKeys: string[];
}

interface FactsLoaded {
  templateId: string;
  facts: TemplateFacts | null;
}

/**
 * The roles and the values to fill in of a template's current version, for the setup step. Read through row level
 * security (menu.sign), like the template pickers.
 */
export function useTemplateFacts(templateId: string | null): { facts: TemplateFacts | null; loading: boolean; error: boolean } {
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<FactsLoaded | null>(null);

  useEffect(() => {
    if (!templateId || !accountId) return;
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createClient();
        const t = await supabase.from("sign_templates").select("current_version_id").eq("id", templateId).maybeSingle();
        if (t.error) throw t.error;
        const versionId = (t.data as { current_version_id: string | null } | null)?.current_version_id;
        if (!versionId) throw new Error("no version");
        const v = await supabase.from("sign_template_versions").select("roles, fields").eq("id", versionId).maybeSingle();
        if (v.error || !v.data) throw v.error ?? new Error("no version");
        const row = v.data as { roles: SignRole[]; fields: PlacedField[] };
        const fields = Array.isArray(row.fields) ? row.fields : [];
        const roles = Array.isArray(row.roles) ? row.roles : [];
        if (!cancelled) setLoaded({ templateId, facts: { roles: roleInfos(roles, fields), mergeKeys: mergeKeysOf(fields).map((k) => k.key) } });
      } catch (err) {
        console.error("[useTemplateFacts] fetch error:", err);
        if (!cancelled) setLoaded({ templateId, facts: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [templateId, accountId]);

  const ready = !!templateId && loaded?.templateId === templateId;
  return { facts: ready ? loaded.facts : null, loading: !!templateId && !ready, error: ready && loaded.facts === null };
}

// ---- one batch, kept fresh ---------------------------------------------------------------------------------

interface JobPageAnswer {
  job: BulkJobView;
  rows: BulkRowView[];
  hasMore: boolean;
}

const PAGE = 200;

/** Read a batch with all its people (a batch holds at most 500: three pages at the most). */
async function readAll(id: string, signal: AbortSignal): Promise<{ job: BulkJobView; rows: BulkRowView[] }> {
  const first = await signRequest<JobPageAnswer>(`/api/sign/bulk/${id}?offset=0&limit=${PAGE}`, { signal });
  const rows = [...first.rows];
  let more = first.hasMore;
  while (more && rows.length < 600) {
    const next = await signRequest<JobPageAnswer>(`/api/sign/bulk/${id}?offset=${rows.length}&limit=${PAGE}`, { signal });
    rows.push(...next.rows);
    more = next.hasMore && next.rows.length > 0;
  }
  return { job: first.job, rows };
}

/**
 * A batch and its people, asked for again every few seconds while it runs (slower after a failure) and not at all once
 * it has finished. `refresh` asks now.
 */
export function useBulkJob(id: string): { job: BulkJobView | null; rows: BulkRowView[]; loading: boolean; errorCode: string | null; refresh: () => void } {
  const [state, setState] = useState<{ job: BulkJobView | null; rows: BulkRowView[]; loading: boolean; errorCode: string | null }>({ job: null, rows: [], loading: true, errorCode: null });
  const [tick, setTick] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const run = async () => {
      let nextStatus: BulkJobView["status"] | null = null;
      let slow = false;
      try {
        const { job, rows } = await readAll(id, controller.signal);
        if (stopped) return;
        failures.current = 0;
        nextStatus = job.status;
        // a long batch is read in up to three pages: ask half as often so the sender's own request budget is not used up
        slow = job.total > PAGE;
        setState({ job, rows, loading: false, errorCode: null });
      } catch (err) {
        if (stopped || (err instanceof DOMException && err.name === "AbortError")) return;
        failures.current += 1;
        const code = err instanceof SignApiError ? err.code : "request_failed";
        // a batch that is not there will not appear: stop asking
        if (code === "job_not_found" || code === "forbidden" || code === "signed_out") {
          setState((s) => ({ ...s, loading: false, errorCode: code }));
          return;
        }
        setState((s) => ({ ...s, loading: false, errorCode: code }));
        nextStatus = "running";
      }
      const base = nextStatus ? nextPollMs(nextStatus, failures.current) : null;
      if (base !== null && !stopped) timer = setTimeout(() => void run(), slow ? base * 2 : base);
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}

/** The workspace's recent batches, for the screen where a new one is started. */
export function useRecentBatches(): { jobs: BulkJobView[]; loading: boolean; error: boolean; refresh: () => void } {
  const { accountId } = useAuth();
  const [state, setState] = useState<{ jobs: BulkJobView[]; loading: boolean; error: boolean }>({ jobs: [], loading: true, error: false });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { jobs } = await signRequest<{ jobs: BulkJobView[] }>("/api/sign/bulk?limit=10", { signal: controller.signal });
        setState({ jobs, loading: false, error: false });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ jobs: [], loading: false, error: true });
      }
    })();
    return () => controller.abort();
  }, [accountId, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}
