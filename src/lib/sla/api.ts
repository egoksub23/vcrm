// ============================================================
// Shared bits of the SLA settings routes (server side, no React).
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { mapSlaDbError, statusForSlaError, validateHolidayPayload } from "./policy";
import type { SlaErrorCode } from "./types";

/** `{ error: <code> }` with the right status; the screens translate the code. */
export function slaFail(code: SlaErrorCode): NextResponse {
  return NextResponse.json({ error: code }, { status: statusForSlaError(code) });
}

/** Convert a thrown value: auth errors keep their own response, the rest become a failure code. */
export function slaCatch(err: unknown): NextResponse {
  return toErrorResponse(err);
}

export function slaDbFail(
  route: string,
  err: { code?: string | null; message?: string | null } | null | undefined,
): NextResponse {
  const code = mapSlaDbError(err);
  if (code === "failed") console.error(`[${route}] database error:`, err);
  return slaFail(code);
}

export interface HolidayInput {
  holiday_date: string;
  name: string;
}

export const MAX_HOLIDAYS = 200;

/** A holidays list from a request body: valid dates, no duplicates, at most MAX_HOLIDAYS. */
export function parseHolidays(
  raw: unknown,
): { ok: true; value: HolidayInput[] } | { ok: false; code: SlaErrorCode } {
  if (!Array.isArray(raw)) return { ok: false, code: "invalid_date" };
  if (raw.length > MAX_HOLIDAYS) return { ok: false, code: "invalid_date" };
  const seen = new Set<string>();
  const out: HolidayInput[] = [];
  for (const item of raw) {
    const r = validateHolidayPayload(item);
    if (!r.ok) return r;
    if (seen.has(r.value.holiday_date)) return { ok: false, code: "duplicate_holiday" };
    seen.add(r.value.holiday_date);
    out.push(r.value);
  }
  return { ok: true, value: out };
}

/** What has to change to turn the stored holidays into the wanted list. */
export function diffHolidays(
  stored: readonly { id: string; holiday_date: string; name: string }[],
  wanted: readonly HolidayInput[],
): { remove: string[]; add: HolidayInput[]; rename: { id: string; name: string }[] } {
  const storedByDate = new Map(stored.map((h) => [h.holiday_date, h]));
  const wantedDates = new Set(wanted.map((h) => h.holiday_date));
  return {
    remove: stored.filter((h) => !wantedDates.has(h.holiday_date)).map((h) => h.id),
    add: wanted.filter((h) => !storedByDate.has(h.holiday_date)),
    rename: wanted
      .filter((h) => storedByDate.has(h.holiday_date) && storedByDate.get(h.holiday_date)!.name !== h.name)
      .map((h) => ({ id: storedByDate.get(h.holiday_date)!.id, name: h.name })),
  };
}
