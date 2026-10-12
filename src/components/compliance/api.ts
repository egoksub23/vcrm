// ============================================================
// Compliance requests, the browser's side of the /api/compliance routes. Browser only (fetch); no Node imports. Every call is `no-store`.
// A failed call is `{ ok: false, code, status, issues? }`; the code is one the server chose (src/lib/compliance/types.ts ERROR_CODES) or `network`.
// ============================================================

import type { PublicFormPatch, PublicFormsAnswer } from "@/lib/compliance/public/settings-types";
import type { RaiseContext, RaiseResult, RaisedItem } from "@/lib/compliance/raise-types";
import type { ComplianceReport } from "@/lib/compliance/reports";
import type { RequestDetail, RequestList, RequestStatus, RequestTypeRow, Viewer } from "@/lib/compliance/types";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number; issues?: { field?: string; code: string }[] };

export function codeOf(status: number, body: unknown): string {
  if (body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string") return (body as { code: string }).code;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "server_error";
}

async function call<T>(method: string, url: string, body?: unknown, isForm = false): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: isForm || body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // not JSON: the status decides
  }
  if (!res.ok) {
    const issues = parsed && typeof parsed === "object" && Array.isArray((parsed as { issues?: unknown }).issues) ? ((parsed as { issues: { field?: string; code: string }[] }).issues) : undefined;
    return { ok: false, code: codeOf(res.status, parsed), status: res.status, issues };
  }
  return { ok: true, data: parsed as T };
}

const BASE = "/api/compliance";

export interface ListQuery {
  type?: string;
  status?: string;
  due?: string;
  assignee?: string;
  mine?: boolean;
  q?: string;
  /** yyyy-mm-dd, the browser's local day */
  from?: string;
  to?: string;
  page?: number;
}

/** The query string for the list: the local days become exact instants (from = start of that day, to = start of the day after). */
export function listQuery(f: ListQuery): string {
  const q = new URLSearchParams();
  if (f.type) q.set("type", f.type);
  if (f.status) q.set("status", f.status);
  if (f.due && f.due !== "all") q.set("due", f.due);
  if (f.assignee) q.set("assignee", f.assignee);
  if (f.mine) q.set("mine", "1");
  if (f.q?.trim()) q.set("q", f.q.trim());
  const day = (v: string | undefined, plus: number): string | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? "");
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plus);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const from = day(f.from, 0);
  const to = day(f.to, 1);
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  if (f.page && f.page > 1) q.set("page", String(f.page));
  return q.toString();
}

export const getList = (f: ListQuery) => call<RequestList>("GET", `${BASE}/requests?${listQuery(f)}`);
export const getDetail = (id: string) => call<RequestDetail>("GET", `${BASE}/requests/${id}`);
export const getTypes = () => call<{ types: RequestTypeRow[]; viewer: Viewer }>("GET", `${BASE}/types`);

export const createRequest = (body: Record<string, unknown>) => call<{ id: string; reference: string }>("POST", `${BASE}/requests`, body);
export const editRequest = (id: string, body: Record<string, unknown>) => call<{ changed: string[] }>("PATCH", `${BASE}/requests/${id}`, body);

export interface TransitionBody {
  to: RequestStatus;
  note?: string;
  identity?: { method: string; methodOther?: string; outcome: string };
  recommendation?: string;
  overrideReason?: string;
  /** A rejection: what the reports group it under, and the words the customer is told. */
  reasonCategory?: string;
  customerReason?: string;
  /** Email the customer (rejecting and completing default to yes, approving to no). */
  notify?: boolean;
}
/** What happened to the customer's email, when one was asked for. */
export interface NoticeOutcome {
  status: "sent" | "failed" | "skipped" | "duplicate";
  detail?: string;
  language?: string;
}
export const transition = (id: string, body: TransitionBody) => call<{ from: string; to: string; notice?: NoticeOutcome }>("POST", `${BASE}/requests/${id}/transition`, body);

export interface NoticePreview {
  subject: string;
  body: string;
  language: string;
  hasAddress: boolean;
}
export const previewNotice = (id: string, body: { kind: string; text?: string; language?: string }) => call<{ preview: NoticePreview }>("POST", `${BASE}/requests/${id}/notices`, { action: "preview", ...body });
export const sendNotice = (id: string, body: { kind: string; text?: string; nonce?: string; language?: string; resend?: boolean }) => call<{ notice: NoticeOutcome }>("POST", `${BASE}/requests/${id}/notices`, { action: "send", ...body });
export const tickStep = (id: string, step: string, done: boolean, note?: string) => call<{ ok: true }>("POST", `${BASE}/requests/${id}/steps/${encodeURIComponent(step)}`, { done, note });
export const setStanding = (id: string, duesOutstanding: boolean, notes?: string) => call<{ ok: true }>("POST", `${BASE}/requests/${id}/standing`, { duesOutstanding, notes });
export const clockAction = (id: string, action: "pause" | "resume", note: string) => call<{ ok: true }>("POST", `${BASE}/requests/${id}/clock`, { action, note });
export const addNote = (id: string, text: string) => call<{ ok: true }>("POST", `${BASE}/requests/${id}/notes`, { text });

export interface RevealResult {
  fields: { key: string; label: { en: string; ms?: string; zh?: string; ko?: string }; value: string }[];
  expiresInSeconds: number;
}
export const reveal = (id: string) => call<RevealResult>("POST", `${BASE}/requests/${id}/reveal`, {});

export function uploadFile(id: string, file: File, field?: string) {
  const form = new FormData();
  form.append("file", file);
  if (field) form.append("field", field);
  return call<{ id: string; name: string }>("POST", `${BASE}/requests/${id}/files`, form, true);
}
export const fileUrl = (id: string, fileId: string) => `${BASE}/requests/${id}/files/${fileId}`;

export const patchType = (key: string, body: Record<string, unknown>) => call<{ type: RequestTypeRow }>("PATCH", `${BASE}/types/${key}`, body);
export const createType = (body: Record<string, unknown>) => call<{ type: RequestTypeRow }>("POST", `${BASE}/types`, body);

export interface LinkChoice {
  kind: "contact" | "ticket" | "incident";
  id: string;
  label: string;
}
export const lookupLinks = (kind: LinkChoice["kind"], q: string) => call<{ choices: LinkChoice[] }>("GET", `${BASE}/links?kind=${kind}&q=${encodeURIComponent(q)}`);

// ---- Part B: raising from the Inbox and from tickets, the public forms' settings, the badge and the reports --------------------------------------

export type RaiseTarget = { conversationId: string } | { ticketId: string };
const targetQuery = (t: RaiseTarget): string => ("conversationId" in t ? `conversationId=${encodeURIComponent(t.conversationId)}` : `ticketId=${encodeURIComponent(t.ticketId)}`);
export const getRaiseContext = (t: RaiseTarget) => call<RaiseContext>("GET", `${BASE}/raise/context?${targetQuery(t)}`);
export const raiseRequest = (body: Record<string, unknown>) => call<RaiseResult>("POST", `${BASE}/raise`, body);
export const getRaised = (t?: RaiseTarget) => call<{ items: RaisedItem[] }>("GET", `${BASE}/raised${t ? `?${targetQuery(t)}` : ""}`);

export const getPublicForms = () => call<PublicFormsAnswer>("GET", `${BASE}/public-forms`);
export const patchPublicForm = (typeKey: string, patch: PublicFormPatch) => call<PublicFormsAnswer>("PATCH", `${BASE}/public-forms`, { typeKey, ...patch });

export const getBadge = () => call<{ count: number }>("GET", `${BASE}/badge`);

export interface ReportQuery {
  /** yyyy-mm-dd, the browser's local day */
  from: string;
  to: string;
  type?: string;
}
const reportQuery = (q: ReportQuery): string => {
  const p = new URLSearchParams(listQuery({ from: q.from, to: q.to, type: q.type }));
  return p.toString();
};
export const getReport = (q: ReportQuery) => call<ComplianceReport>("GET", `${BASE}/reports?${reportQuery(q)}`);
export const reportCsvUrl = (q: ReportQuery) => `${BASE}/reports/export?${reportQuery(q)}`;
