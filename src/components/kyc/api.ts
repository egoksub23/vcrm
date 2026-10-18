// ============================================================
// KYC review, the browser's side of the /api/kyc routes. Browser only (fetch); no Node imports.
// The browser never sees the back end, its key or its address: only these routes. Every call is `no-store`.
// ============================================================

import type { KycAccessRow, KycStatus, KycValidationList } from "@/lib/kyc/types";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number };

/** The code of a failed call: the one the route sent, else one derived from the status. */
export function codeOf(status: number, body: unknown): string {
  if (body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string") return (body as { code: string }).code;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "upstream_unreachable";
  return "bad_response";
}

async function request(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { method: "GET", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
  } catch {
    return null;
  }
}

async function call<T>(url: string): Promise<ApiResult<T>> {
  const res = await request(url);
  if (!res) return { ok: false, code: "network", status: 0 };
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: the status decides
  }
  if (!res.ok) return { ok: false, code: codeOf(res.status, body), status: res.status };
  return { ok: true, data: body as T };
}

export const getStatus = (check = false) => call<KycStatus & { service?: "up" | "down" }>(`/api/kyc/status${check ? "?check=1" : ""}`);

export function getValidations(friendId: string, opts: { reload?: boolean; revealValidationId?: string; beforeId?: string } = {}) {
  const q = new URLSearchParams({ limit: "50" });
  if (friendId) q.set("friend_id", friendId);
  if (opts.beforeId) q.set("before_id", opts.beforeId);
  if (opts.reload) q.set("reload", "1");
  if (opts.revealValidationId) {
    q.set("reveal", "1");
    q.set("validation_id", opts.revealValidationId);
  }
  return call<KycValidationList>(`/api/kyc/validations?${q.toString()}`);
}

/** The image as a Blob (the caller makes an object URL from it and revokes the URL when done). */
export async function getImage(validationId: string, friendId: string | null): Promise<ApiResult<Blob>> {
  const q = friendId ? `?friend_id=${encodeURIComponent(friendId)}` : "";
  const res = await request(`/api/kyc/validations/${encodeURIComponent(validationId)}/image${q}`);
  if (!res) return { ok: false, code: "network", status: 0 };
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    return { ok: false, code: codeOf(res.status, body), status: res.status };
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "image/jpeg" && type !== "image/png" && type !== "image/webp") return { ok: false, code: "image_type_unsupported", status: 200 };
  return { ok: true, data: await res.blob() };
}

export interface LogFilters {
  userId: string;
  friendId: string;
  action: string;
  /** yyyy-mm-dd, the browser's local day */
  from: string;
  to: string;
}

/** The query string for the access log: the local days become exact instants (from = start of that day, to = start of the day after). */
export function logQuery(f: LogFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  if (f.userId) q.set("user_id", f.userId);
  if (f.friendId.trim()) q.set("friend_id", f.friendId.trim());
  if (f.action) q.set("action", f.action);
  const day = (v: string, plus: number): string | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plus);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const from = day(f.from, 0);
  const to = day(f.to, 1);
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

export interface AccessLogPage {
  rows: KycAccessRow[];
  people: { id: string; name: string }[];
  hasMore: boolean;
}

export const getAccessLog = (f: LogFilters, before?: string) => call<AccessLogPage>(`/api/kyc/access-log?${logQuery(f, before ? { before } : {})}`);
export const accessLogExportUrl = (f: LogFilters) => `/api/kyc/access-log/export?${logQuery(f)}`;
