// Entry points the routes and the cron call. Everything is best-effort: a notification problem never fails the work that caused it
// (raising an incident, closing one); it shows up in the message log and on the incident instead.

import { defaultAdapters, type AdapterMap } from "./adapters";
import { dispatchDue, runTrigger, sweepTimers, type DispatchSummary, type EngineStore, type SweepSummary, type TriggerResult } from "./engine";
import { PgEngineStore, accountsWithTimedRules } from "./pg-store";
import { autoPurgeAll } from "./retention-data";
import { createAdminPgDb } from "@/lib/postgres/db";
import type { RuleTrigger } from "./rules";

export interface EventOutcome {
  trigger: TriggerResult;
  dispatch: DispatchSummary;
}

/** Apply the rules for one event on one incident, then send what became due. Never throws. */
export async function processIncidentEvent(
  incidentId: string,
  trigger: RuleTrigger,
  deps: { store?: EngineStore; adapters?: AdapterMap } = {},
): Promise<EventOutcome | null> {
  try {
    const store = deps.store ?? new PgEngineStore();
    const result = await runTrigger(store, { incidentId, trigger });
    const dispatch = await dispatchDue(store, deps.adapters ?? defaultAdapters());
    return { trigger: result, dispatch };
  } catch (err) {
    console.error(`[incident-engine] ${trigger} failed for incident ${incidentId}:`, err);
    return null;
  }
}

/** Does this school have a notification rule switched on for newly raised incidents? When it does, the old "email every manager" message is not sent as well. */
export async function accountHasRaisedRules(accountId: string, store?: EngineStore): Promise<boolean> {
  try {
    return ((await (store ?? new PgEngineStore()).loadRules(accountId, "raised"))).some((r) => r.enabled);
  } catch {
    return false;
  }
}

export interface CronOutcome extends SweepSummary, DispatchSummary {
  /** Incidents removed today under a school's own retention period (only in the daily window). */
  autoPurged?: number;
}

/** The once-a-day housekeeping runs in the first two minutes of 03:00 Malaysia time (19:00 UTC). The cron calls every minute; this picks the one that counts. */
export function isDailyWindow(now: Date): boolean {
  return now.getUTCHours() === 19 && now.getUTCMinutes() < 2;
}

/** The once-a-minute job: run timed rules, then send the outbox (new rows and retries). */
export async function runIncidentCron(deps: { store?: EngineStore; adapters?: AdapterMap; accounts?: string[] } = {}): Promise<CronOutcome> {
  const store = deps.store ?? new PgEngineStore();
  const accounts = deps.accounts ?? (await accountsWithTimedRules());
  const swept = await sweepTimers(store, accounts);
  const sent = await dispatchDue(store, deps.adapters ?? defaultAdapters(), 100);
  const out: CronOutcome = { ...swept, ...sent };

  // Daily housekeeping, never allowed to fail the heartbeat: forget expired report links, and remove records past a school's own retention period.
  if (isDailyWindow(new Date())) {
    try {
      await createAdminPgDb().rpc("purge_expired_incident_sessions");
      out.autoPurged = (await autoPurgeAll()).reduce((n, r) => n + r.incidents, 0);
    } catch (err) {
      console.error("[incident-engine] daily housekeeping failed:", err);
    }
  }
  return out;
}
