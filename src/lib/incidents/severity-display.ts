// How a severity reads on screen. The bank template already uses P1 to P4; a school's template names its levels (Critical, High, Medium, Low), so here
// they are numbered as well, most serious first: "P1 · Critical". One place, so every screen says the same thing.

const BNM_SLUGS = new Set(["P1", "P2", "P3", "P4"]);

/** "P2 · High" for a named level on a school template (numbered by its place in the template), the plain label otherwise. */
export function severityText(slug: string, levels: readonly { slug: string; label: string }[] | null | undefined): string {
  const i = levels ? levels.findIndex((l) => l.slug === slug) : -1;
  if (i < 0) return slug;
  const label = levels![i].label;
  if (BNM_SLUGS.has(slug)) return label === slug ? slug : `${slug} · ${label}`;
  return `P${i + 1} · ${label}`;
}
