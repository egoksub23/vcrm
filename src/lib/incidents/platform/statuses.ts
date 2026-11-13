// A school's own wording and extra steps for incident statuses (migration 226). Pure: rows in, options out.
//
// An incident always has one of the six base statuses in `status`; that is what timers, rules, requirements and reports use. The school may rename a base
// status, and add extra statuses that each count as one base status. The incident's own choice is `status_key` (null means the base status itself).

export const BASE_STATUSES = ["reported", "triaged", "contained", "investigating", "recovered", "closed"] as const;
export type BaseStatus = (typeof BASE_STATUSES)[number];

export const MAX_EXTRA_STATUSES = 12;
export const MAX_LABEL = 40;

export interface StatusOptionRow {
  key: string;
  label: string;
  base_status: string;
  position: number;
  is_builtin: boolean;
  is_active: boolean;
}

export interface StatusOption {
  key: string;
  /** The school's wording. Null for a base status the school has not renamed: the app's own translated name is used. */
  label: string | null;
  base: BaseStatus;
  builtin: boolean;
  active: boolean;
}

export const isBase = (v: unknown): v is BaseStatus => typeof v === "string" && (BASE_STATUSES as readonly string[]).includes(v);

/** The base statuses followed, under each, by the school's extras in their own order. Inactive extras are included (the setup page shows them). */
export function mergeOptions(rows: readonly StatusOptionRow[]): StatusOption[] {
  const renamed = new Map(rows.filter((r) => r.is_builtin).map((r) => [r.key, r]));
  const extras = rows.filter((r) => !r.is_builtin && isBase(r.base_status)).sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  const out: StatusOption[] = [];
  for (const base of BASE_STATUSES) {
    const own = renamed.get(base);
    out.push({ key: base, label: own?.label ?? null, base, builtin: true, active: true });
    for (const e of extras.filter((x) => x.base_status === base)) out.push({ key: e.key, label: e.label, base, builtin: false, active: e.is_active });
  }
  return out;
}

/** The option an incident is in: its own choice when that still exists, else its base status. */
export function optionFor(options: readonly StatusOption[], status: string, statusKey: string | null | undefined): StatusOption | undefined {
  return (statusKey ? options.find((o) => o.key === statusKey) : undefined) ?? options.find((o) => o.builtin && o.key === status);
}

/** The words for an incident's status: the school's wording, or the app's own translated name for the base status. */
export function statusText(options: readonly StatusOption[], status: string, statusKey: string | null | undefined, ownName: (base: string) => string): string {
  const o = optionFor(options, status, statusKey);
  return o?.label ?? ownName(o?.base ?? status);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);

/** A key for a new extra status, made from its label, never the same as one already taken (or a base status). */
export function makeKey(label: string, taken: ReadonlySet<string>): string {
  const base = `s_${slug(label) || "status"}`;
  let key = base;
  for (let n = 2; taken.has(key) || (BASE_STATUSES as readonly string[]).includes(key); n++) key = `${base}_${n}`;
  return key;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseLabel(v: unknown): Parsed<string> {
  const label = typeof v === "string" ? v.trim() : "";
  if (!label) return { ok: false, error: "Give the status a name." };
  if (label.length > MAX_LABEL) return { ok: false, error: `The name can be at most ${MAX_LABEL} characters.` };
  return { ok: true, value: label };
}
