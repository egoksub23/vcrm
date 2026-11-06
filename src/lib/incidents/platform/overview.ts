// What the Overview page shows: four counts and a short "needs action now" list. Pure, so the rules for what counts as urgent are tested.

import { severityRank } from "@/lib/incidents/constants";

export interface OverviewIncident {
  id: string;
  incident_number: number;
  created_at: string;
  title: string;
  incident_type: string;
  severity: string;
  status: string;
}
export interface OverviewStep {
  id: string;
  incident_id: string;
  title: string;
  due_at: string | null;
  role_key: string | null;
}
export interface OverviewAck {
  incident_id: string;
  first_ask_at: string | null;
  acknowledged: boolean;
}

export type NeedsAction =
  | { kind: "overdue_step"; incidentId: string; title: string; overdueMinutes: number }
  | { kind: "unacknowledged"; incidentId: string; title: string; severity: string; waitingMinutes: number }
  | { kind: "serious_open"; incidentId: string; title: string; severity: string };

export interface Overview {
  open: number;
  overdueSteps: number;
  unacknowledged: number;
  nearMissesThisMonth: number;
  needsAction: NeedsAction[];
  byCategory: { code: string; count: number }[];
}

const isOpen = (i: OverviewIncident) => i.status !== "closed";

/** A category counts as a near miss when its code is NMS (School template) or its name says so. */
export function isNearMissCategory(cat: { code: string; name: string }): boolean {
  return cat.code === "NMS" || /near[\s-]?miss/i.test(cat.name);
}

export function buildOverview(args: {
  incidents: readonly OverviewIncident[];
  steps: readonly OverviewStep[];
  ack: readonly OverviewAck[];
  categories: readonly { code: string; name: string }[];
  now: Date;
  limit?: number;
}): Overview {
  const { incidents, steps, ack, categories, now } = args;
  const nowMs = now.getTime();
  const byId = new Map(incidents.map((i) => [i.id, i]));
  const openIds = new Set(incidents.filter(isOpen).map((i) => i.id));

  const overdue = steps
    .filter((s) => s.due_at && new Date(s.due_at).getTime() < nowMs && openIds.has(s.incident_id))
    .map((s) => ({ s, minutes: Math.floor((nowMs - new Date(s.due_at as string).getTime()) / 60_000) }));

  const waiting = ack
    .filter((a) => !a.acknowledged && a.first_ask_at && byId.get(a.incident_id)?.status === "reported")
    .map((a) => ({ a, inc: byId.get(a.incident_id) as OverviewIncident, minutes: Math.floor((nowMs - new Date(a.first_ask_at as string).getTime()) / 60_000) }));

  const nearMissCodes = new Set(categories.filter(isNearMissCategory).map((c) => c.code));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();
  const nearMisses = incidents.filter((i) => nearMissCodes.has(i.incident_type) && new Date(i.created_at).getTime() >= monthStart).length;

  const needs: { weight: number; item: NeedsAction }[] = [];
  const mentioned = new Set<string>();
  for (const w of waiting) {
    mentioned.add(w.inc.id);
    needs.push({ weight: 1000 - severityRank(w.inc.severity) * 100 + Math.min(w.minutes, 99) / 100, item: { kind: "unacknowledged", incidentId: w.inc.id, title: w.inc.title, severity: w.inc.severity, waitingMinutes: w.minutes } });
  }
  for (const o of overdue) {
    const inc = byId.get(o.s.incident_id);
    needs.push({ weight: 500 + Math.min(o.minutes, 4000) / 10, item: { kind: "overdue_step", incidentId: o.s.incident_id, title: `${inc ? `INC-${new Date(inc.created_at).getUTCFullYear()}-${inc.incident_number}` : ""} ${o.s.title}`.trim(), overdueMinutes: o.minutes } });
  }
  for (const i of incidents) {
    if (!isOpen(i) || mentioned.has(i.id) || severityRank(i.severity) > 0) continue;
    needs.push({ weight: 300, item: { kind: "serious_open", incidentId: i.id, title: i.title, severity: i.severity } });
  }
  needs.sort((a, b) => b.weight - a.weight);

  const counts = new Map<string, number>();
  const cutoff = nowMs - 90 * 86_400_000;
  for (const i of incidents) if (new Date(i.created_at).getTime() >= cutoff) counts.set(i.incident_type, (counts.get(i.incident_type) ?? 0) + 1);

  return {
    open: openIds.size,
    overdueSteps: overdue.length,
    unacknowledged: waiting.length,
    nearMissesThisMonth: nearMisses,
    needsAction: needs.slice(0, args.limit ?? 8).map((n) => n.item),
    byCategory: [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
  };
}

// ---- My tasks ---------------------------------------------------------------------------------------------------

export interface TaskStep extends OverviewStep {
  status: string;
}

/** A step is mine when it belongs to a role I hold, or it has no role and I am the incident lead. */
export function isMyTask(step: Pick<OverviewStep, "role_key" | "incident_id">, myRoles: readonly string[], leadOf: ReadonlySet<string>): boolean {
  if (step.role_key) return myRoles.includes(step.role_key);
  return leadOf.has(step.incident_id);
}
