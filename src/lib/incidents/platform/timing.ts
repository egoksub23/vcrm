// Timing a school can change, with the shipped values as defaults (migration 218). Pure checks, so the rules are tested; the route only stores what passes.
//   * the acknowledgement wait: how long a notice may go unacknowledged before the "nobody acknowledged" rule fires;
//   * a built-in required step's deadline (PDPA, ISO, school policy): the shipped hours, the school's own hours, or none, and whether the step is on.

import type { Parsed } from "./pack";

export const DEFAULT_ACK_WAIT_MINUTES = 30;
/** The starter recipe whose wait this setting drives. */
export const ACK_RECIPE_KEY = "remind_unacknowledged";
/** Packs whose deadlines come from law, so the screen says to confirm a change with the data protection officer. */
export const LEGAL_PACK_SLUGS: readonly string[] = ["pdpa_my"];

export function parseAckWait(value: unknown): Parsed<number> {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 60 * 24 * 30) {
    return { ok: false, error: "Say how long to wait as a whole number of minutes, between 1 and 43200 (30 days)." };
  }
  return { ok: true, value: n };
}

export type StepMode = "default" | "hours" | "none";

export interface StepSettingInput {
  ruleId: string;
  mode: StepMode;
  dueHours: number | null;
  enabled: boolean;
}

export function parseStepSetting(body: unknown): Parsed<StepSettingInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the step." };
  const b = body as Record<string, unknown>;
  if (typeof b.rule_id !== "string" || b.rule_id === "") return { ok: false, error: "Choose a step." };
  if (b.mode !== "default" && b.mode !== "hours" && b.mode !== "none") return { ok: false, error: "Choose the shipped deadline, your own hours, or no deadline." };
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return { ok: false, error: "Say whether the step is on or off." };
  let dueHours: number | null = null;
  if (b.mode === "hours") {
    const n = typeof b.hours === "string" && b.hours.trim() !== "" ? Number(b.hours) : b.hours;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 8760) return { ok: false, error: "The deadline is a whole number of hours between 1 and 8760 (a year)." };
    dueHours = n;
  }
  return { ok: true, value: { ruleId: b.rule_id, mode: b.mode, dueHours, enabled: b.enabled !== false } };
}

/** What is stored for a school's choice: a row, or null when the choice is just the shipped values (so the row is removed). */
export function toOverrideRow(s: StepSettingInput): { due_hours: number | null; no_deadline: boolean; enabled: boolean } | null {
  if (s.mode === "default" && s.enabled) return null;
  return { due_hours: s.mode === "hours" ? s.dueHours : null, no_deadline: s.mode === "none", enabled: s.enabled };
}

export interface StoredOverride {
  due_hours: number | null;
  no_deadline: boolean;
  enabled: boolean;
}

/** The deadline in hours a new incident will get for this step (null = none). */
export function effectiveHours(shipped: number | null, ov: StoredOverride | null): number | null {
  if (!ov) return shipped;
  if (ov.no_deadline) return null;
  return ov.due_hours ?? shipped;
}

/** The mode a stored override stands for, for the screen. */
export function modeOf(ov: StoredOverride | null): StepMode {
  if (!ov) return "default";
  if (ov.no_deadline) return "none";
  return ov.due_hours !== null ? "hours" : "default";
}
