// Server side of the workflow requirements: read the facts, decide with workflow.ts, and when a role's approval is what is missing, ask for it.
// Uses the service connection for the settings, steps and approvals (the person making the move may not be allowed to read all of them), after the
// incident itself has been read as that person so another school's incident is a 404.

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { labelOf } from "./roles";
import { notifyRole, dispatchDue } from "./engine";
import { PgEngineStore } from "./pg-store";
import { defaultAdapters } from "./adapters";
import { evaluateMove, type Guard } from "./workflow";

export const STATUS_WORDS: Record<string, string> = {
  reported: "Reported",
  triaged: "Triaged",
  contained: "Contained",
  investigating: "Investigating",
  recovered: "Recovered",
  closed: "Closed",
};

export interface Approval {
  id: string;
  role_key: string;
  for_status: string | null;
  requested_at: string;
  decision: "approved" | "rejected" | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

export async function loadApprovals(db: PgDb, incidentId: string, accountId: string): Promise<Approval[]> {
  const { data } = await db.from("incident_approvals").select("id, role_key, for_status, requested_at, decision, decided_by, decided_at, note").eq("incident_id", incidentId).eq("account_id", accountId).order("requested_at", { ascending: false });
  return (data ?? []) as Approval[];
}

export async function loadGuards(db: PgDb, accountId: string): Promise<{ guards: Guard[]; allowBackward: boolean }> {
  const [g, s] = await Promise.all([
    db.from("incident_workflow_guards").select("to_status, requires").eq("account_id", accountId),
    db.from("incident_settings").select("workflow_allow_backward").eq("account_id", accountId).maybeSingle(),
  ]);
  return { guards: (g.data ?? []) as Guard[], allowBackward: (s.data as { workflow_allow_backward: boolean } | null)?.workflow_allow_backward ?? true };
}

export type MoveCheck = { ok: true } | { ok: false; status: number; error: string; problems: string[] };

/** May this incident move to `to`? When only a role's approval is missing, the request goes out as part of the answer. */
export async function checkMove(args: { incident: { id: string; account_id: string; status: string; root_cause: string | null; incident_lead_id: string | null }; to: string; userId: string; admin?: PgDb }): Promise<MoveCheck> {
  const admin = args.admin ?? createAdminPgDb();
  const { incident, to } = args;
  if (incident.status === to) return { ok: true };

  const [{ guards, allowBackward }, steps, approvals, roles] = await Promise.all([
    loadGuards(admin, incident.account_id),
    admin.from("incident_obligations").select("id", { count: "exact", head: true }).eq("incident_id", incident.id).eq("status", "open"),
    loadApprovals(admin, incident.id, incident.account_id),
    admin.from("incident_roles").select("key, name").eq("account_id", incident.account_id),
  ]);
  const names = new Map(((roles.data ?? []) as { key: string; name: Record<string, string> }[]).map((r) => [r.key, labelOf(r.name)]));
  const roleName = (k: string) => names.get(k) ?? k.replace(/_/g, " ");

  const result = evaluateMove({
    facts: { from: incident.status, to, rootCause: incident.root_cause, leadAssigned: Boolean(incident.incident_lead_id), openSteps: steps.count ?? 0, approvals },
    guards,
    allowBackward,
    roleName,
    statusName: (s) => STATUS_WORDS[s] ?? s,
  });
  if (result.ok) return { ok: true };

  // Only the approval is missing or stale: ask the role now (once), so the person making the move does not have to chase it.
  if (result.needsApprovalFrom && !approvals.some((a) => a.role_key === result.needsApprovalFrom && a.decision === null)) {
    const { data: created } = await admin
      .from("incident_approvals")
      .insert({ account_id: incident.account_id, incident_id: incident.id, role_key: result.needsApprovalFrom, for_status: to, requested_by: args.userId })
      .select("id")
      .single();
    const id = (created as { id: string } | null)?.id;
    if (id) {
      const store = new PgEngineStore(admin);
      await notifyRole(store, { incidentId: incident.id, roleKey: result.needsApprovalFrom, reason: "approval", refKey: `approval:${id}` });
      await dispatchDue(store, defaultAdapters(), 20);
    }
  }
  return { ok: false, status: 409, error: result.problems.join(" "), problems: result.problems };
}
