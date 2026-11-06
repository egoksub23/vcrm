// Entry points the routes and the cron call. Everything is best-effort: a notification problem never fails the work that caused it
// (raising an incident, closing one); it shows up in the message log and on the incident instead.

import { defaultAdapters, type AdapterMap } from "./adapters";
import { dispatchDue, runTrigger, sweepTimers, type DispatchSummary, type EngineStore, type SweepSummary, type TriggerResult } from "./engine";
import { PgEngineStore, accountsWithTimedRules } from "./pg-store";
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
export async function accountHasRaisedRules(accountId: string, store: EngineStore = new PgEngineStore()): Promise<boolean> {
  try {
    return (await store.loadRules(accountId, "raised")).some((r) => r.enabled);
  } catch {
    return false;
  }
}

export interface CronOutcome extends SweepSummary, DispatchSummary {}

/** The once-a-minute job: run timed rules, then send the outbox (new rows and retries). */
export async function runIncidentCron(deps: { store?: EngineStore; adapters?: AdapterMap; accounts?: string[] } = {}): Promise<CronOutcome> {
  const store = deps.store ?? new PgEngineStore();
  const accounts = deps.accounts ?? (await accountsWithTimedRules());
  const swept = await sweepTimers(store, accounts);
  const sent = await dispatchDue(store, deps.adapters ?? defaultAdapters(), 100);
  return { ...swept, ...sent };
}
