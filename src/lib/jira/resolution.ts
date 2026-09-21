/**
 * Which ticket resolution (migration 096) a Jira resolution stands for.
 *
 * When Jira reports an issue Done, the linked ticket becomes Resolved or Closed
 * and needs a resolution. If the issue's Jira resolution can be matched BY NAME
 * to an active entry of the workspace's catalogue, that entry is used; anything
 * else falls back, in the database, to "Resolved in Jira". Matching ignores case,
 * spacing and apostrophe style, and knows the few Jira wordings that mean the
 * same as one of the default entries ("Won't Do" = "Won't fix", ...). It never
 * maps Jira's generic "Done" (that says nothing about how it was resolved).
 */

export interface CatalogueEntry {
  id: string;
  name: string;
  is_active: boolean;
}

/** Lower-case, straight apostrophes, single spaces. */
export function normalizeResolutionName(name: string | null | undefined): string {
  return (name ?? "")
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Jira wording (normalised) -> the default catalogue entry it means (normalised). */
const ALIASES: Record<string, string> = {
  "won't do": "won't fix",
  "wont do": "won't fix",
  "wont fix": "won't fix",
  wontfix: "won't fix",
  "can't reproduce": "cannot reproduce",
  "cant reproduce": "cannot reproduce",
  answered: "answered / information given",
  "duplicate issue": "duplicate",
  "not responding": "customer did not respond",
};

/** Names Jira uses for "finished" that carry no information about how. */
const GENERIC = new Set(["done", "resolved", "complete", "completed", "closed"]);

/** The catalogue id for a Jira resolution name, or null when there is no match. */
export function mapJiraResolution(
  jiraName: string | null | undefined,
  catalogue: readonly CatalogueEntry[],
): string | null {
  const wanted = normalizeResolutionName(jiraName);
  if (!wanted || GENERIC.has(wanted)) return null;
  const active = catalogue.filter((c) => c.is_active);
  const exact = active.find((c) => normalizeResolutionName(c.name) === wanted);
  if (exact) return exact.id;
  const alias = ALIASES[wanted];
  if (alias) return active.find((c) => normalizeResolutionName(c.name) === alias)?.id ?? null;
  return null;
}
