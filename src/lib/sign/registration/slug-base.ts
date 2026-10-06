// ============================================================
// The readable start of a registration address (/r/<start>-<random>), made from a form's name. A module of its own,
// with nothing from the server in it, so the Settings screen can show a live preview of the address while the name
// is typed. The random end is made on the server (slug.ts) when the form is saved.
// ============================================================

/** The most the start can be: 40 characters in all, a hyphen and the 8 random ones. */
export const MAX_BASE = 40 - 1 - 8;

/** Lower case, accents removed, anything else a hyphen; "register" when nothing is left. */
export function slugBase(name: string): string {
  const folded = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const base = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_BASE).replace(/-+$/g, "");
  return base.length >= 2 ? base : "register";
}
