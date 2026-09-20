// ============================================================
// The first-run checklist (Settings > Integrations > Jira > Connection): the
// in-product version of docs/jira-setup.md section 7.3. Each step turns green
// as it becomes true. Pure: the route gathers the facts, this decides.
// ============================================================

import type { JiraConnectionRow, JiraSettings } from "./types";

export const CHECKLIST_STEPS = ["credentials", "connected", "project", "webhook", "sync"] as const;
export type ChecklistStepId = (typeof CHECKLIST_STEPS)[number];

export interface ChecklistStep {
  id: ChecklistStepId;
  done: boolean;
}

export interface ChecklistFacts {
  /** JIRA_CLIENT_ID and JIRA_CLIENT_SECRET are set on the server. */
  configured: boolean;
  connection: Pick<JiraConnectionRow, "status" | "webhook_ids" | "last_catchup_at"> | null;
  settings: Pick<JiraSettings, "projects">;
  /** A webhook delivery arrived, or a queued sync job finished. */
  syncEvidence: boolean;
}

/**
 * credentials  the app id and secret are in the server environment
 * connected    a connection exists and is healthy
 * project      at least one project is allowed (or a default project chosen)
 * webhook      Jira has registered webhooks with us
 * sync         a sync has really happened: a catch-up succeeded, a webhook
 *              arrived or a queued sync job finished
 */
export function computeChecklist(f: ChecklistFacts): ChecklistStep[] {
  const conn = f.connection && f.connection.status !== "revoked" ? f.connection : null;
  const connected = !!conn && conn.status === "active";
  const hooks = Array.isArray(conn?.webhook_ids) ? conn.webhook_ids.length > 0 : false;
  return [
    { id: "credentials", done: f.configured },
    { id: "connected", done: connected },
    { id: "project", done: connected && (f.settings.projects.allowed.length > 0 || !!f.settings.projects.default_project) },
    { id: "webhook", done: connected && hooks },
    { id: "sync", done: connected && (!!conn?.last_catchup_at || f.syncEvidence) },
  ];
}

/** The first step that is not done yet (what to do next), or null when all are. */
export function nextChecklistStep(steps: readonly ChecklistStep[]): ChecklistStepId | null {
  return steps.find((s) => !s.done)?.id ?? null;
}
