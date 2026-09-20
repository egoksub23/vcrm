// Client-side plumbing for Settings > Integrations > Jira: one fetch helper
// that turns every /api/integrations/jira/* answer into { ok, data } or
// { ok: false, error }, the response shapes the screens share, and the
// friendly text for each error code the API can return.

import { useTranslations } from "next-intl";

import type { ChecklistStep } from "@/lib/jira/checklist";
import type { FieldMappingRow, JiraFieldInfo } from "@/lib/jira/field-mapping";
import type { JiraConnectionRow, JiraSettings, ReportResult } from "@/lib/jira/types";

export const JIRA_API = "/api/integrations/jira";

export interface JiraApiError {
  status: number;
  code: string;
  message: string;
  /** Seconds, from a 429 jira_rate_limited answer. */
  retryAfter?: number;
}

export type JiraResult<T> = { ok: true; data: T } | { ok: false; error: JiraApiError };

export async function jiraFetch<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<JiraResult<T>> {
  try {
    const res = await fetch(`${JIRA_API}/${path}`, {
      method: init.method ?? "GET",
      cache: "no-store",
      signal: init.signal,
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const payload = (await res.json().catch(() => null)) as
      | (Record<string, unknown> & { error?: unknown; message?: unknown; retry_after_seconds?: unknown })
      | null;
    if (!res.ok) {
      return {
        ok: false,
        error: {
          status: res.status,
          code: typeof payload?.error === "string" ? payload.error : res.status === 403 ? "forbidden" : "unknown",
          message: typeof payload?.message === "string" ? payload.message : "",
          retryAfter: typeof payload?.retry_after_seconds === "number" ? payload.retry_after_seconds : undefined,
        },
      };
    }
    return { ok: true, data: (payload ?? {}) as T };
  } catch {
    return { ok: false, error: { status: 0, code: "network", message: "" } };
  }
}

const KNOWN_ERRORS = new Set([
  "reauth_required",
  "no_connection",
  "jira_not_configured",
  "not_configured",
  "jira_permission",
  "jira_not_found",
  "jira_rate_limited",
  "jira_rejected",
  "jira_unavailable",
  "resync_too_soon",
  "forbidden",
  "no_permission",
  "invalid_state",
  "invalid_site",
  "site_mismatch",
  "bad_request",
  "not_found",
  "network",
  "internal",
]);

/** Codes new in 0.45.0: their sentences live under Settings.jira.depth.errors. */
const DEPTH_ERRORS = new Set(["unsupported_field", "incompatible_field", "too_many", "project_not_allowed"]);

/** The translated sentence for an API error (falls back to a generic one). */
export function useJiraErrorText(): (error: Pick<JiraApiError, "code" | "retryAfter">) => string {
  const t = useTranslations("Settings.jira.errors");
  const td = useTranslations("Settings.jira.depth.errors");
  return (error) =>
    DEPTH_ERRORS.has(error.code)
      ? td(error.code)
      : KNOWN_ERRORS.has(error.code)
        ? t(error.code, { seconds: error.retryAfter ?? 30 })
        : t("unknown");
}

// ------------------------------------------------------------
// Response shapes (mirror the route header comments)
// ------------------------------------------------------------

export interface JiraConnectionPayload {
  configured: boolean;
  callbackUrl: string;
  connection: JiraConnectionRow | null;
  settings: JiraSettings;
  counts: { links: number; paused: number; broken: number };
  /** 0.45.0: the first-run checklist, computed on the server. */
  checklist?: ChecklistStep[];
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
export interface JiraStatusOption {
  id: string;
  name: string;
  category: string | null;
}

export interface JiraSite {
  id: string;
  name: string;
  url: string;
}

export interface JiraMemberRow {
  userId: string;
  name: string;
  email: string | null;
  match: { jiraAccountId: string; displayName: string | null; method: string } | null;
}

export interface JiraPeopleData {
  canManageAll: boolean;
  members: JiraMemberRow[];
}

export interface JiraUserHit {
  accountId: string;
  displayName: string;
  email: string | null;
}

export interface JiraDiagnostics {
  connection: { status: string; statusReason: string | null; siteName: string | null } | null;
  tokenExpiresAt?: string | null;
  lastCatchupAt?: string | null;
  lastReportAt?: string | null;
  rateLimit?: {
    reason?: string | null;
    remaining?: number | null;
    limit?: number | null;
    reset?: string | null;
    at?: string;
  } | null;
  webhook?: {
    registered: boolean;
    count: number;
    expiresAt: string | null;
    checkedAt: string | null;
    lastDeliveryAt: string | null;
  };
  queue?: { pending: number; running: number; dead: number };
  links?: { ok: number; paused: number; broken: number };
  failures?: { linkId: string; key: string; state: string; error: string | null }[];
  events?: { id: string; level: string; kind: string; message: string; link_id: string | null; created_at: string }[];
  deadJobs?: { id: string; kind: string; attempts: number; last_error: string | null; finished_at: string | null }[];
  /** 0.45.0 */
  catchupStalled?: boolean;
  catchupMinutes?: number | null;
  report?: ReportResult | null;
  webhookTrust?: {
    signed: number;
    unsigned: number;
    rejectedUnsigned: number;
    lastUnsignedAt: string | null;
    since: string | null;
    requireSigned: boolean;
  };
}

/** POST diagnostics { action: "test_connection" }. */
export type JiraTestResult =
  | { ok: true; user: { displayName: string | null; accountId: string | null }; projects: { key: string; name: string }[]; hasMore: boolean }
  | { ok: false; code: string; message: string };

/** GET fields?project=KEY: the Fields tab. */
export interface JiraFieldsData {
  project: string;
  issueType: JiraNamed;
  issueTypes: JiraNamed[];
  fields: JiraFieldInfo[];
  cachedAt: string;
  cached: boolean;
  ticketFields: { id: string; label: string; field_type: "text" | "textarea" | "number" | "date" | "dropdown" | "checkbox"; options: string[] }[];
  mappings: FieldMappingRow[];
}

export interface JiraMappingInput {
  projectKey: string;
  issueTypeId: string;
  ticketFieldId: string;
  jiraFieldId: string;
  direction: "to_jira" | "from_jira" | "both";
  whenMissing: "skip" | "clear" | "default";
  defaultValue?: string | null;
  label?: string | null;
}
