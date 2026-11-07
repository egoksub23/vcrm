// Loads incidents for registers, trends and the evidence pack (server side, as the signed-in person, so row-level security decides what is visible).

import type { PgDb } from "@/lib/postgres/db";
import type { RegisterIncident } from "./registers";
import { textDates } from "./dates";
import { loadActiveTemplate } from "./setup-data";

export const REGISTER_LIMIT = 5000;
const SELECT = "id, incident_number, created_at, closed_at, title, incident_type, severity, status, incident_flags, source, is_test, activity";

export async function loadRegisterRows(db: PgDb, accountId: string, since: string | null = null): Promise<{ rows: RegisterIncident[]; truncated: boolean }> {
  let q = db.from("incidents").select(SELECT).eq("account_id", accountId).order("created_at", { ascending: false }).limit(REGISTER_LIMIT + 1);
  if (since) q = q.gte("created_at", since);
  const { data } = await q;
  const all = ((data ?? []) as RegisterIncident[]).map((r) => textDates(r, ["created_at", "closed_at"]));
  const rows = all.slice(0, REGISTER_LIMIT);

  // How many people were named on each (a count, never the names).
  const counts = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 400) {
    const ids = rows.slice(i, i + 400).map((r) => r.id);
    const { data: people } = await db.from("incident_involved").select("incident_id").in("incident_id", ids);
    for (const p of (people ?? []) as { incident_id: string }[]) counts.set(p.incident_id, (counts.get(p.incident_id) ?? 0) + 1);
  }
  return { rows: rows.map((r) => ({ ...r, involved_count: counts.get(r.id) ?? 0 })), truncated: all.length > REGISTER_LIMIT };
}

export async function loadNames(db: PgDb, accountId: string): Promise<{ categories: { code: string; name: string }[]; severities: { slug: string; label: string }[] }> {
  const t = await loadActiveTemplate(db, accountId);
  return { categories: (t?.categories ?? []).map((c) => ({ code: c.code, name: c.name })), severities: (t?.severities ?? []).map((s) => ({ slug: s.slug, label: s.label })) };
}
