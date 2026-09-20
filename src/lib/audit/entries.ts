// ============================================================
// Server helpers shared by the audit routes: resolve actor names and
// "does the item still exist", and shape rows into API entries.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AuditEntry, AuditRow } from "./types";

/** user id -> display name for the members of `accountId`. */
export async function loadActorNames(
  supabase: SupabaseClient,
  accountId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return names;
  const { data } = await supabase
    .from("profiles")
    .select("user_id, full_name, email")
    .eq("account_id", accountId)
    .in("user_id", ids);
  for (const p of (data ?? []) as {
    user_id: string;
    full_name: string | null;
    email: string | null;
  }[]) {
    names.set(p.user_id, p.full_name?.trim() || p.email || "");
  }
  return names;
}

/** Live tables behind the entity types whose existence is checked. */
const EXISTENCE_TABLES: Readonly<Record<string, string>> = {
  tag: "tags",
  snippet: "quick_replies",
  article: "ai_knowledge_documents",
  team: "teams",
};

/**
 * For each of tag / snippet / article / team, the set of ids that still
 * exist. RLS hides soft-deleted rows, so "found" means "not removed".
 */
export async function loadExistingIds(
  supabase: SupabaseClient,
  rows: readonly Pick<AuditRow, "entity_type" | "entity_id">[],
): Promise<Map<string, Set<string>>> {
  const wanted = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.entity_id || !EXISTENCE_TABLES[r.entity_type]) continue;
    if (!wanted.has(r.entity_type)) wanted.set(r.entity_type, new Set());
    wanted.get(r.entity_type)!.add(r.entity_id);
  }
  const found = new Map<string, Set<string>>();
  await Promise.all(
    [...wanted].map(async ([type, ids]) => {
      const { data } = await supabase
        .from(EXISTENCE_TABLES[type])
        .select("id")
        .in("id", [...ids]);
      found.set(type, new Set(((data ?? []) as { id: string }[]).map((r) => r.id)));
    }),
  );
  return found;
}

export function toAuditEntry(
  row: AuditRow,
  names: ReadonlyMap<string, string>,
  existing?: ReadonlyMap<string, ReadonlySet<string>>,
): AuditEntry {
  const checked = existing?.get(row.entity_type);
  const trackable = !!row.entity_id && !!EXISTENCE_TABLES[row.entity_type] && !!existing;
  return {
    id: row.id,
    createdAt: row.created_at,
    actor: {
      id: row.actor_id,
      kind: row.actor_kind,
      // Live profile name first (a rename shows up), else the snapshot
      // taken when the row was written (the person may have left).
      name: (row.actor_id ? names.get(row.actor_id) : "") || row.actor_label || "",
    },
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: row.entity_label,
    summary: row.summary,
    entityExists: trackable ? (checked?.has(row.entity_id!) ?? false) : null,
  };
}
