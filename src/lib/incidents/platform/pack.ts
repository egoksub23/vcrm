// A school's own required steps ("our own pack"). Each step is: when an incident involves X, this role must do Y within Z hours. Pure checks, so the rules
// are tested; the route only stores what passes.

import { INCIDENT_FLAGS } from "@/lib/incidents/constants";

export interface PackRuleInput {
  title: string;
  description: string | null;
  triggerFlag: string;
  dueHours: number | null;
  roleKey: string | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_PACK_RULES = 60;

export function parsePackRule(body: unknown, knownRoles: readonly string[]): Parsed<PackRuleInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the step." };
  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (title.length < 3) return { ok: false, error: "Describe the step in a few words, for example \"Phone the parents\"." };
  if (title.length > 160) return { ok: false, error: "The step is too long (160 characters at most)." };
  const description = typeof b.description === "string" && b.description.trim() ? b.description.trim().slice(0, 500) : null;
  if (typeof b.trigger_flag !== "string" || !(INCIDENT_FLAGS as readonly string[]).includes(b.trigger_flag)) return { ok: false, error: "Choose what the incident involves." };
  let dueHours: number | null = null;
  if (b.due_hours !== null && b.due_hours !== undefined && b.due_hours !== "") {
    const n = Number(b.due_hours);
    if (!Number.isInteger(n) || n < 1 || n > 8760) return { ok: false, error: "The deadline is a whole number of hours between 1 and 8760 (a year), or leave it empty for no deadline." };
    dueHours = n;
  }
  let roleKey: string | null = null;
  if (b.role_key !== null && b.role_key !== undefined && b.role_key !== "") {
    if (typeof b.role_key !== "string" || !knownRoles.includes(b.role_key)) return { ok: false, error: "Choose one of the school's roles, or leave it empty so the incident lead does it." };
    roleKey = b.role_key;
  }
  return { ok: true, value: { title, description, triggerFlag: b.trigger_flag, dueHours, roleKey } };
}

/** The next free step code, `step_1`, `step_2` ... so a deleted code is never reused for something different. */
export function nextStepCode(existing: readonly string[]): string {
  const nums = existing.map((c) => /^step_(\d+)$/.exec(c)?.[1]).filter((n): n is string => Boolean(n)).map(Number);
  return `step_${Math.max(0, ...nums) + 1}`;
}

/** The slug of a school's own pack: unique per school, and obviously not a built-in. */
export function packSlug(accountId: string): string {
  return `school_pack_${accountId.replace(/-/g, "").slice(0, 12)}`;
}

/** "within 4 hours" / "within 2 days" / "no deadline", for the list. */
export function describeDue(hours: number | null): string {
  if (hours === null) return "no deadline";
  if (hours % 24 === 0) return `within ${hours / 24} ${hours / 24 === 1 ? "day" : "days"}`;
  return `within ${hours} ${hours === 1 ? "hour" : "hours"}`;
}
