// Who was told when an incident was escalated: the notices the "escalated" rules queued right after the level was raised. The Timeline shows them on the
// escalation line, so nobody has to open the message log to answer "who knows about this?". Pure: the page hands in what it has already loaded.

export interface ToldDelivery {
  reason: string;
  created_at: string;
  recipient_name: string;
  role_key: string;
  status: string;
  is_test?: boolean;
}

export interface ToldPerson {
  name: string;
  roleKey: string;
  /** Every notice to this person failed or was skipped. */
  failed: boolean;
}

/** The longest a notice can trail the escalation it belongs to: the rules run straight after the level is raised, then the outbox queues them. */
const WINDOW_MS = 10 * 60_000;

/**
 * People with an escalation notice queued from `at` until the next escalation (or ten minutes, whichever is sooner). One entry per person and role; a person
 * counts as failed only when none of their notices went out.
 */
export function toldAtEscalation(at: string, nextAt: string | null, deliveries: readonly ToldDelivery[]): ToldPerson[] {
  const from = new Date(at).getTime() - 2000;
  const to = Math.min(new Date(at).getTime() + WINDOW_MS, nextAt ? new Date(nextAt).getTime() : Infinity);
  const people = new Map<string, ToldPerson>();
  for (const d of deliveries) {
    if (d.reason !== "escalated" || d.is_test) continue;
    const t = new Date(d.created_at).getTime();
    if (t < from || t >= to) continue;
    const key = `${d.role_key}|${d.recipient_name.toLowerCase()}`;
    const ok = d.status !== "failed" && d.status !== "skipped";
    const seen = people.get(key);
    if (!seen) people.set(key, { name: d.recipient_name, roleKey: d.role_key, failed: !ok });
    else if (ok) seen.failed = false;
  }
  return [...people.values()];
}
