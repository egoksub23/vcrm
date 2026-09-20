// ============================================================
// The Jira Cloud REST client. Every call to Jira goes through here.
//
//   - Always https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...; the
//     cloud id is validated as a UUID when the client is built, so no text a
//     user typed can steer a request to another host.
//   - The access token comes from a callback (the TokenManager): refreshed
//     when it is about to expire, and once more on a 401.
//   - 429 / 503: waits for Retry-After (capped), otherwise capped exponential
//     backoff with jitter; when the wait would be long the error is thrown so
//     the queue reschedules the job instead of holding a worker.
//   - A per-connection concurrency limit, and a global in-process brake that
//     opens when Atlassian says the quota shared by every Vircle customer is
//     used up.
//   - Rate-limit headers are handed to `onRateLimit` (logged into
//     jira_sync_events / jira_connections.rate_limit).
//   - It never deletes Jira data: the only DELETE it will send is for the
//     dynamic webhooks Vircle registered itself.
//
// `fetch`, the clock and the sleep are injectable, so all of it is unit-tested
// against mocked responses.
// ============================================================

import {
  JiraAuthError,
  JiraConfigError,
  JiraNetworkError,
  JiraNotFoundError,
  JiraPermissionError,
  JiraRateLimitError,
  JiraServerError,
  JiraValidationError,
} from "./errors";
import { isCloudId } from "./oauth";
import {
  JIRA_API_BASE,
  ISSUE_FIELDS,
  type JiraComment,
  type JiraIssue,
  type RateLimitSnapshot,
} from "./types";

type FetchFn = typeof fetch;

export interface JiraClientOptions {
  cloudId: string;
  /** Returns a usable access token; pass `rejectedToken` after a 401 to force a refresh. */
  getAccessToken: (opts?: { rejectedToken?: string }) => Promise<string>;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Stable key for the concurrency limit (the connection id). */
  connectionKey?: string;
  concurrency?: number;
  /** In-request retries for 429 / 5xx before the error is thrown (default 3). */
  maxRetries?: number;
  /** A Retry-After longer than this is thrown, not slept (default 30 s). */
  maxInlineWaitMs?: number;
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
  /** Called when Jira rejects even a freshly refreshed token (the connection is dead: reconnect). */
  onAuthFailure?: () => void | Promise<void>;
  baseUrl?: string;
}

// ------------------------------------------------------------
// Per-connection concurrency and the global brake
// ------------------------------------------------------------

class Limiter {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

const limiters = new Map<string, Limiter>();
function limiterFor(key: string, max: number): Limiter {
  let l = limiters.get(key);
  if (!l) {
    l = new Limiter(max);
    limiters.set(key, l);
  }
  return l;
}

let brakeUntil = 0;
/** Milliseconds the whole app is paused for (0 = not braking). */
export function globalBrakeRemaining(now: number = Date.now()): number {
  return Math.max(0, brakeUntil - now);
}
export function engageGlobalBrake(ms: number, now: number = Date.now()): void {
  brakeUntil = Math.max(brakeUntil, now + ms);
}
export function resetGlobalBrake(): void {
  brakeUntil = 0;
  limiters.clear();
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const enc = encodeURIComponent;

/** Retry-After as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Capped exponential backoff with jitter; attempt 0 = the first retry. */
export function backoffMs(attempt: number, random: () => number = Math.random, baseMs = 1000, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

function readRateLimit(res: Response, now: number): RateLimitSnapshot | null {
  const reason = res.headers.get("RateLimit-Reason");
  const remaining = res.headers.get("X-RateLimit-Remaining");
  const limit = res.headers.get("X-RateLimit-Limit");
  const reset = res.headers.get("X-RateLimit-Reset");
  if (!reason && !remaining && !limit && res.status !== 429) return null;
  const num = (v: string | null) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    reason,
    remaining: num(remaining),
    limit: num(limit),
    reset: reset ?? null,
    status: res.status,
    at: new Date(now).toISOString(),
  };
}

function parseValidation(data: unknown): JiraValidationError {
  const d = (data ?? {}) as { errorMessages?: unknown; errors?: unknown };
  const messages = Array.isArray(d.errorMessages) ? d.errorMessages.filter((m): m is string => typeof m === "string") : [];
  const fieldErrors: Record<string, string> = {};
  if (d.errors && typeof d.errors === "object") {
    for (const [k, v] of Object.entries(d.errors as Record<string, unknown>)) if (typeof v === "string") fieldErrors[k] = v;
  }
  return new JiraValidationError(messages, fieldErrors);
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | (string | number)[]>;
  body?: unknown;
  /** Return null instead of throwing JiraNotFoundError. */
  allow404?: boolean;
  /** A body that is not JSON (multipart uploads). No Content-Type is set: fetch adds the boundary. */
  rawBody?: BodyInit;
  /** Extra request headers (X-Atlassian-Token for uploads). */
  headers?: Record<string, string>;
  /** "manual" hands a 3xx answer to `readResponse` instead of following it. */
  redirect?: "manual";
  /** Read a successful (or, with redirect: "manual", redirected) answer instead of parsing JSON. */
  readResponse?: (res: Response) => Promise<unknown>;
}

// ------------------------------------------------------------
// The client
// ------------------------------------------------------------

export class JiraClient {
  readonly cloudId: string;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly limiter: Limiter;
  private readonly maxRetries: number;
  private readonly maxInlineWaitMs: number;
  private readonly base: string;

  constructor(private readonly opts: JiraClientOptions) {
    if (!isCloudId(opts.cloudId)) throw new JiraConfigError("The Jira cloud id is not a valid UUID");
    this.cloudId = opts.cloudId.toLowerCase();
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.limiter = limiterFor(opts.connectionKey ?? this.cloudId, opts.concurrency ?? 3);
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxInlineWaitMs = opts.maxInlineWaitMs ?? 30_000;
    this.base = (opts.baseUrl ?? JIRA_API_BASE).replace(/\/+$/, "");
  }

  /** The URL of a REST path; `path` is validated so nothing can leave the API. */
  url(path: string, query?: RequestOptions["query"]): string {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || path.includes("://") || path.includes("?") || path.includes("#")) {
      throw new JiraConfigError("Refusing a malformed Jira path");
    }
    const u = new URL(`${this.base}/ex/jira/${this.cloudId}/rest/api/3${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return u.toString();
  }

  /** Vircle never deletes Jira data; only its own webhook registrations can be removed. */
  private assertAllowed(method: string, path: string): void {
    if (method === "DELETE" && path !== "/webhook") {
      throw new JiraConfigError("The Jira client never deletes Jira data");
    }
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T | null> {
    this.assertAllowed(method, path);
    const url = this.url(path, opts.query);

    const brake = globalBrakeRemaining(this.now());
    if (brake > 0) throw new JiraRateLimitError(brake, { global: true, reason: "jira-quota-global-based" });

    return this.limiter.run(() => this.send<T>(method, url, opts));
  }

  private async send<T>(method: string, url: string, opts: RequestOptions): Promise<T | null> {
    let token = await this.opts.getAccessToken();
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: opts.readResponse ? "*/*" : "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.headers ?? {}),
          },
          body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
          ...(opts.redirect ? { redirect: opts.redirect } : {}),
        });
      } catch {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt, this.random));
          continue;
        }
        throw new JiraNetworkError();
      }

      const snapshot = readRateLimit(res, this.now());
      if (snapshot) this.opts.onRateLimit?.(snapshot);

      if (opts.readResponse && (res.ok || (opts.redirect === "manual" && res.status >= 300 && res.status < 400))) {
        return (await opts.readResponse(res)) as T;
      }
      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        return text ? (JSON.parse(text) as T) : null;
      }

      if (res.status === 401) {
        if (!refreshed) {
          refreshed = true;
          token = await this.opts.getAccessToken({ rejectedToken: token });
          continue;
        }
        await Promise.resolve(this.opts.onAuthFailure?.()).catch(() => undefined);
        throw new JiraAuthError("Jira rejected the access token", 401);
      }

      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseRetryAfter(res.headers.get("Retry-After"), this.now());
        const reason = res.headers.get("RateLimit-Reason");
        const isGlobal = reason === "jira-quota-global-based";
        const waitMs = retryAfter ?? backoffMs(attempt, this.random);
        if (isGlobal) engageGlobalBrake(Math.max(waitMs, 1000), this.now());
        // Long waits and a shared pool that is used up go back to the queue.
        if (isGlobal || attempt >= this.maxRetries || waitMs > this.maxInlineWaitMs) {
          if (res.status === 503 && retryAfter === null && !isGlobal) throw new JiraServerError("Jira is unavailable", 503);
          throw new JiraRateLimitError(waitMs, { global: isGlobal, reason });
        }
        await this.sleep(waitMs);
        continue;
      }

      if (res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt, this.random));
          continue;
        }
        throw new JiraServerError(`Jira answered ${res.status}`, res.status);
      }

      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        // no body
      }
      if (res.status === 400) throw parseValidation(data);
      // A file the site refuses for its size is a permanent answer about that file, not an outage.
      if (res.status === 413) throw new JiraValidationError(["The file is larger than this Jira site allows"]);
      if (res.status === 403) throw new JiraPermissionError();
      if (res.status === 404 || res.status === 410) {
        if (opts.allow404) return null;
        throw new JiraNotFoundError();
      }
      throw new JiraServerError(`Unexpected answer from Jira (${res.status})`, res.status);
    }
  }

  // ---------- identity, projects, metadata ----------

  getMyself() {
    return this.request<{ accountId: string; displayName?: string; emailAddress?: string }>("GET", "/myself");
  }

  listProjects(args: { query?: string; startAt?: number; maxResults?: number } = {}) {
    return this.request<{ values: { id: string; key: string; name: string }[]; isLast?: boolean; total?: number }>(
      "GET",
      "/project/search",
      { query: { query: args.query, startAt: args.startAt ?? 0, maxResults: args.maxResults ?? 50, orderBy: "name" } },
    );
  }

  listCreateIssueTypes(project: string) {
    return this.request<{ issueTypes?: { id: string; name: string; subtask?: boolean }[]; values?: { id: string; name: string; subtask?: boolean }[] }>(
      "GET",
      `/issue/createmeta/${enc(project)}/issuetypes`,
      { query: { maxResults: 100 } },
    );
  }

  listCreateFields(project: string, issueTypeId: string) {
    return this.request<{ fields?: CreateField[]; values?: CreateField[] }>(
      "GET",
      `/issue/createmeta/${enc(project)}/issuetypes/${enc(issueTypeId)}`,
      { query: { maxResults: 200 } },
    );
  }

  listPriorities() {
    return this.request<{ values?: { id: string; name: string }[] }>("GET", "/priority/search", { query: { maxResults: 50 } });
  }

  listProjectStatuses(project: string) {
    return this.request<{ id: string; name: string; statuses: { id: string; name: string; statusCategory?: { key?: string } }[] }[]>(
      "GET",
      `/project/${enc(project)}/statuses`,
    );
  }

  searchUsers(query: string) {
    return this.request<{ accountId: string; displayName?: string; emailAddress?: string; active?: boolean; accountType?: string }[]>(
      "GET",
      "/user/search",
      { query: { query, maxResults: 20 } },
    );
  }

  assignableUsers(project: string, query: string) {
    return this.request<{ accountId: string; displayName?: string; active?: boolean }[]>("GET", "/user/assignable/search", {
      query: { project, query, maxResults: 20 },
    });
  }

  // ---------- issues ----------

  getIssue(idOrKey: string, fields: readonly string[] = ISSUE_FIELDS) {
    return this.request<JiraIssue>("GET", `/issue/${enc(idOrKey)}`, { query: { fields: [...fields] }, allow404: false });
  }

  /** Read several issues in one call; `null` entries never appear (missing ones are simply absent). */
  async bulkFetch(idsOrKeys: string[], fields: readonly string[] = ISSUE_FIELDS): Promise<JiraIssue[]> {
    if (idsOrKeys.length === 0) return [];
    const out: JiraIssue[] = [];
    for (let i = 0; i < idsOrKeys.length; i += 100) {
      const res = await this.request<{ issues?: JiraIssue[] }>("POST", "/issue/bulkfetch", {
        body: { issueIdsOrKeys: idsOrKeys.slice(i, i + 100), fields: [...fields] },
      });
      out.push(...(res?.issues ?? []));
    }
    return out;
  }

  /** One page of JQL results (the removed /search is never used). */
  searchIssues(args: { jql: string; fields?: readonly string[]; nextPageToken?: string; maxResults?: number }) {
    return this.request<{ issues?: JiraIssue[]; nextPageToken?: string }>("POST", "/search/jql", {
      body: {
        jql: args.jql,
        fields: [...(args.fields ?? ISSUE_FIELDS)],
        maxResults: args.maxResults ?? 50,
        ...(args.nextPageToken ? { nextPageToken: args.nextPageToken } : {}),
      },
    });
  }

  createIssue(fields: Record<string, unknown>, properties?: { key: string; value: unknown }[]) {
    return this.request<{ id: string; key: string; self?: string }>("POST", "/issue", {
      body: { fields, ...(properties ? { properties } : {}) },
    });
  }

  /** Change fields of an issue: only what is in `body` changes (PUT /issue). */
  updateIssue(idOrKey: string, body: { fields?: Record<string, unknown>; update?: Record<string, unknown[]> }) {
    return this.request("PUT", `/issue/${enc(idOrKey)}`, { body });
  }

  /** The fields this issue can be edited with right now (with their allowed values): the edit screen. */
  getEditMeta(idOrKey: string) {
    return this.request<{ fields?: Record<string, Omit<CreateField, "fieldId">> }>("GET", `/issue/${enc(idOrKey)}/editmeta`);
  }

  listProjectComponents(project: string) {
    return this.request<{ id: string; name: string }[]>("GET", `/project/${enc(project)}/components`);
  }

  assignIssue(idOrKey: string, accountId: string | null) {
    return this.request("PUT", `/issue/${enc(idOrKey)}/assignee`, { body: { accountId } });
  }

  getTransitions(idOrKey: string) {
    return this.request<{ transitions?: import("./settings").JiraTransition[] }>("GET", `/issue/${enc(idOrKey)}/transitions`, {
      query: { expand: "transitions.fields" },
    });
  }

  doTransition(idOrKey: string, transitionId: string, fields?: Record<string, unknown>) {
    return this.request("POST", `/issue/${enc(idOrKey)}/transitions`, {
      body: { transition: { id: transitionId }, ...(fields && Object.keys(fields).length ? { fields } : {}) },
    });
  }

  // ---------- comments ----------

  addComment(idOrKey: string, body: unknown, properties?: { key: string; value: unknown }[]) {
    return this.request<JiraComment>("POST", `/issue/${enc(idOrKey)}/comment`, {
      body: { body, ...(properties ? { properties } : {}) },
    });
  }

  updateComment(idOrKey: string, commentId: string, body: unknown) {
    return this.request<JiraComment>("PUT", `/issue/${enc(idOrKey)}/comment/${enc(commentId)}`, { body: { body } });
  }

  getComment(idOrKey: string, commentId: string) {
    return this.request<JiraComment>("GET", `/issue/${enc(idOrKey)}/comment/${enc(commentId)}`, {
      query: { expand: "properties" },
      allow404: true,
    });
  }

  listComments(idOrKey: string, args: { startAt?: number; maxResults?: number } = {}) {
    return this.request<{ comments?: JiraComment[]; total?: number }>("GET", `/issue/${enc(idOrKey)}/comment`, {
      query: { startAt: args.startAt ?? 0, maxResults: args.maxResults ?? 100, orderBy: "created", expand: "properties" },
    });
  }

  // ---------- attachments ----------

  /** The site attachment settings: { enabled, uploadLimit } (bytes). */
  getAttachmentMeta() {
    return this.request<{ enabled?: boolean; uploadLimit?: number }>("GET", "/attachment/meta", { allow404: true });
  }

  /**
   * Add one file to an issue: multipart/form-data, field "file", with the
   * X-Atlassian-Token: no-check header Jira demands. Returns the created
   * attachment(s) (Jira answers with a list).
   */
  uploadAttachment(idOrKey: string, file: { filename: string; contentType: string; data: Uint8Array }) {
    const form = new FormData();
    form.append("file", new Blob([file.data as BlobPart], { type: file.contentType }), file.filename);
    return this.request<{ id: string; filename?: string; mimeType?: string; size?: number; content?: string }[]>(
      "POST",
      `/issue/${enc(idOrKey)}/attachments`,
      { rawBody: form, headers: { "X-Atlassian-Token": "no-check" } },
    );
  }

  /**
   * Download an attachment through the authenticated content endpoint. Jira
   * answers 303 with a signed link on Atlassian media host; only that redirect
   * is followed, and only to a host on `isAllowedMediaHost`. Nothing a user
   * typed ever becomes a URL here. The size is checked against the headers
   * first and again while streaming, so an oversized file is never buffered.
   */
  async downloadAttachment(attachmentId: string, maxBytes: number): Promise<DownloadResult> {
    if (!/^\d{1,20}$/.test(attachmentId)) return { ok: false, reason: "not_found" };
    const fetchFn = this.fetchFn;
    const first = await this.request<{ location: string | null; direct: Response | null }>(
      "GET",
      `/attachment/content/${attachmentId}`,
      {
        redirect: "manual",
        allow404: true,
        readResponse: async (res) => ({
          location: res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null,
          direct: res.ok ? res : null,
        }),
      },
    );
    if (!first) return { ok: false, reason: "not_found" };

    let res: Response;
    if (first.direct) {
      res = first.direct;
    } else {
      if (!first.location) return { ok: false, reason: "bad_redirect" };
      let target: URL;
      try {
        target = new URL(first.location, "https://api.atlassian.com");
      } catch {
        return { ok: false, reason: "bad_redirect" };
      }
      if (target.protocol !== "https:" || !isAllowedMediaHost(target.hostname)) return { ok: false, reason: "bad_redirect" };
      try {
        // The signed link carries its own authorisation: no bearer token goes to the media host.
        res = await fetchFn(target.toString(), { method: "GET", redirect: "manual" });
      } catch {
        return { ok: false, reason: "failed" };
      }
      if (res.status >= 300 && res.status < 400) return { ok: false, reason: "bad_redirect" };
      if (!res.ok) return { ok: false, reason: res.status === 404 ? "not_found" : "failed" };
    }
    const declared = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "failed" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
    const data = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.byteLength;
    }
    return { ok: true, data, contentType: res.headers.get("Content-Type") };
  }

  // ---------- back link ----------

  /** Create or update the "Vircle ticket" link on the issue (same globalId = same link). */
  upsertRemoteLink(
    idOrKey: string,
    link: { globalId: string; url: string; title: string; summary?: string; resolved?: boolean },
  ) {
    return this.request<{ id?: number | string; self?: string }>("POST", `/issue/${enc(idOrKey)}/remotelink`, {
      body: {
        globalId: link.globalId,
        application: { type: "com.vircle.crm", name: "Vircle" },
        relationship: "Vircle ticket",
        object: {
          url: link.url,
          title: link.title,
          ...(link.summary ? { summary: link.summary } : {}),
          status: { resolved: !!link.resolved },
        },
      },
    });
  }

  // ---------- webhooks (dynamic) ----------

  registerWebhooks(args: { url: string; events: readonly string[]; jqlFilter: string; fieldIdsFilter?: string[] }) {
    return this.request<{ webhookRegistrationResult?: { createdWebhookId?: number; errors?: string[] }[] }>("POST", "/webhook", {
      body: {
        url: args.url,
        webhooks: [
          {
            events: [...args.events],
            jqlFilter: args.jqlFilter,
            ...(args.fieldIdsFilter ? { fieldIdsFilter: args.fieldIdsFilter } : {}),
          },
        ],
      },
    });
  }

  listWebhooks() {
    return this.request<{ values?: { id: number; jqlFilter?: string; events?: string[]; expirationDate?: string }[]; isLast?: boolean }>(
      "GET",
      "/webhook",
      { query: { maxResults: 100 } },
    );
  }

  refreshWebhooks(webhookIds: number[]) {
    return this.request<{ expirationDate?: string }>("PUT", "/webhook/refresh", { body: { webhookIds } });
  }

  deleteWebhooks(webhookIds: number[]) {
    return this.request("DELETE", "/webhook", { body: { webhookIds } });
  }

  // ---------- personal data report ----------

  /**
   * Atlassian's personal-data report. Not under /rest/api/3: the address is
   * fixed. The exact request and response shapes are from Atlassian's
   * user-privacy guide and have not been proven against a live site.
   */
  async reportAccounts(accounts: { accountId: string; updatedAt: string }[]): Promise<{ accountId: string; status: string }[]> {
    const token = await this.opts.getAccessToken();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/app/report-accounts/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ accounts }),
      });
    } catch {
      throw new JiraNetworkError();
    }
    if (res.status === 204) return [];
    if (res.status === 401) throw new JiraAuthError("Jira rejected the access token", 401);
    if (res.status === 429) throw new JiraRateLimitError(parseRetryAfter(res.headers.get("Retry-After"), this.now()) ?? 60_000);
    if (res.status >= 500) throw new JiraServerError(`Atlassian answered ${res.status}`, res.status);
    if (!res.ok) throw parseValidation(await res.json().catch(() => null));
    const data = (await res.json().catch(() => null)) as { accounts?: { accountId: string; status: string }[] } | null;
    return data?.accounts ?? [];
  }
}

export type DownloadResult =
  | { ok: true; data: Uint8Array; contentType: string | null }
  | { ok: false; reason: "too_large" | "bad_redirect" | "not_found" | "failed" };

/**
 * Hosts a redirect from the attachment content endpoint may point at:
 * Atlassian media service and the customer own <site>.atlassian.net (never any
 * other host, whatever the redirect says).
 */
export function isAllowedMediaHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "api.media.atlassian.com" ||
    h === "media.atlassian.com" ||
    h === "api.atlassian.com" ||
    /^[a-z0-9-]+\.atlassian\.net$/.test(h) ||
    /^[a-z0-9-]+\.media\.atlassian\.com$/.test(h)
  );
}

export interface CreateField {
  fieldId: string;
  key?: string;
  name: string;
  required: boolean;
  hasDefaultValue?: boolean;
  operations?: string[];
  allowedValues?: { id?: string; name?: string; value?: string; key?: string }[];
  schema?: { type?: string; items?: string; system?: string; custom?: string };
  autoCompleteUrl?: string;
}
