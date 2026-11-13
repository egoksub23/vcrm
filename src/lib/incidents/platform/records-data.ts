// Loads incidents for registers, trends and the evidence pack (server side, as the signed-in person, so row-level security decides what is visible).

import type { PgDb } from "@/lib/postgres/db";
import type { RegisterIncident } from "./registers";
import { textDates } from "./dates";
import { loadActiveTemplate } from "./setup-data";

export const REGISTER_LIMIT = 5000;
const SELECT = "id, incident_number, created_at, closed_at, title, incident_type, severity, status, incident_flags, source, is_test, activity, standard_id, occurred_at";

export async function loadRegisterRows(db: PgDb, accountId: string, since: string | null = null): Promise<{ rows: RegisterIncident[]; truncated: boolean }> {
  // A voided incident (raised by mistake) is not part of any report or register.
  let q = db.from("incidents").select(SELECT).eq("account_id", accountId).is("voided_at", null).order("created_at", { ascending: false }).limit(REGISTER_LIMIT + 1);
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

export interface StandardNames {
  categories: { code: string; name: string }[];
  severities: { slug: string; label: string }[];
}

/**
 * The category and severity names of the templates the given incidents were raised under. An incident keeps the template it was raised under (a school can
 * switch template later), so a code like "AT" is named from its own template, not from whichever is active now. `fallback` is the active template's names,
 * used for an incident with no template of its own.
 */
export async function loadNamesForStandards(db: PgDb, accountId: string, standardIds: readonly (string | null | undefined)[]): Promise<StandardNames & { byStandard: Map<string, StandardNames> }> {
  const ids = [...new Set(standardIds.filter((x): x is string => !!x))];
  const byStandard = new Map<string, StandardNames>(ids.map((id) => [id, { categories: [], severities: [] }]));
  if (ids.length > 0) {
    const [cats, sevs] = await Promise.all([
      db.from("incident_type_catalogue").select("standard_id, code, name").in("standard_id", ids),
      db.from("incident_severity_levels").select("standard_id, slug, label").in("standard_id", ids),
    ]);
    for (const c of (cats.data ?? []) as { standard_id: string; code: string; name: string }[]) byStandard.get(c.standard_id)?.categories.push({ code: c.code, name: c.name });
    for (const s of (sevs.data ?? []) as { standard_id: string; slug: string; label: string }[]) byStandard.get(s.standard_id)?.severities.push({ slug: s.slug, label: s.label });
  }
  const fallback = await loadNames(db, accountId);
  const first = ids.length > 0 ? byStandard.get(ids[0]) : undefined;
  return { categories: first && first.categories.length > 0 ? first.categories : fallback.categories, severities: first && first.severities.length > 0 ? first.severities : fallback.severities, byStandard };
}
