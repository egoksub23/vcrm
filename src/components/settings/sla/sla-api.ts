// Browser-side calls to /api/account/sla/* (Settings > SLA & business hours).
// Every call resolves to { ok: true, data } or { ok: false, code }; the code is
// one of SLA_ERROR_CODES and the screens translate it (Settings.sla.errors.*).

import { invalidateSlaConfig } from "@/hooks/use-sla-config";
import type { WeeklyHours } from "@/lib/sla/business-time";
import type { PolicyPayload, SchedulePayload } from "@/lib/sla/policy";
import { SLA_ERROR_CODES, type SlaErrorCode } from "@/lib/sla/types";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: SlaErrorCode };

async function call<T>(method: string, url: string, body?: unknown, refresh = true): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) {
      const code = (SLA_ERROR_CODES as readonly string[]).includes(json?.error ?? "")
        ? (json!.error as SlaErrorCode)
        : res.status === 403
          ? "forbidden"
          : "failed";
      return { ok: false, code };
    }
    if (refresh) invalidateSlaConfig();
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, code: "failed" };
  }
}

export interface HolidayDraft {
  date: string;
  name: string;
}

export type ScheduleBody = Required<Pick<SchedulePayload, "name" | "timezone">> & {
  weekly: WeeklyHours;
  holidays: HolidayDraft[];
  is_default?: boolean;
};

export interface ApplyResult {
  matched: number;
  overdue: number;
  examined: number;
  truncated: boolean;
  applied: boolean;
}

export const slaApi = {
  createSchedule: (body: ScheduleBody) => call<{ schedule: { id: string } }>("POST", "/api/account/sla/schedules", body),
  updateSchedule: (id: string, body: Partial<ScheduleBody>) =>
    call<{ schedule: { id: string } }>("PATCH", `/api/account/sla/schedules/${id}`, body),
  deleteSchedule: (id: string) => call<{ ok: true }>("DELETE", `/api/account/sla/schedules/${id}`),
  createPolicy: (body: PolicyPayload) => call<{ policy: { id: string } }>("POST", "/api/account/sla/policies", body),
  updatePolicy: (id: string, body: PolicyPayload) =>
    call<{ policy: { id: string } }>("PATCH", `/api/account/sla/policies/${id}`, body),
  deletePolicy: (id: string) => call<{ ok: true }>("DELETE", `/api/account/sla/policies/${id}`),
  reorderPolicies: (ids: string[]) => call<{ ok: true }>("PUT", "/api/account/sla/policies/reorder", { ids }),
  /** dryRun true only counts; false applies. Applying refreshes the ticket screens' configuration cache too. */
  applyToOpen: (dryRun: boolean) =>
    call<ApplyResult>("POST", "/api/account/sla/apply", { dryRun }, !dryRun),
};
