// ============================================================
// The template library (Sign > Templates), browser side: the row the screen shows, how rows are filtered and
// ordered, and how a status looks. Pure, so the rules are tested.
// ============================================================

export type TemplateStatus = "draft" | "active" | "archived";
export const TEMPLATE_STATUSES: readonly TemplateStatus[] = ["draft", "active", "archived"];

/** A template as the library lists it (its row, plus what is counted from its versions). */
export interface LibraryTemplate {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  status: TemplateStatus;
  tags: string[];
  addon_key: string | null;
  addon_version: string | null;
  customised: boolean;
  updated_at: string;
  /** How many versions have been saved. */
  versionCount: number;
}

export interface LibraryFilters {
  /** "all", "none" (no category) or a category id. */
  category: string;
  status: "all" | TemplateStatus;
  search: string;
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = { category: "all", status: "all", search: "" };

export const isLibraryFiltered = (f: LibraryFilters): boolean => f.category !== "all" || f.status !== "all" || f.search.trim() !== "";

/** Filter, then order: archived last, the rest most recently changed first (ties by name). */
export function filterTemplates(rows: readonly LibraryTemplate[], f: LibraryFilters): LibraryTemplate[] {
  const q = f.search.trim().toLowerCase();
  return rows
    .filter((r) => {
      if (f.category === "none" ? r.category_id !== null : f.category !== "all" && r.category_id !== f.category) return false;
      if (f.status !== "all" && r.status !== f.status) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q));
    })
    .sort((a, b) => {
      const archived = Number(a.status === "archived") - Number(b.status === "archived");
      if (archived !== 0) return archived;
      return b.updated_at.localeCompare(a.updated_at) || a.name.localeCompare(b.name);
    });
}

/** Rows of `sign_template_versions` (only the columns needed) counted per template. */
export function countVersions(rows: readonly { template_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.template_id, (counts.get(r.template_id) ?? 0) + 1);
  return counts;
}

const MUTED = "bg-muted text-muted-foreground";

/** Soft tints that read in light and dark; the word carries the meaning, the tint only helps. */
export const TEMPLATE_STATUS_BADGE: Record<TemplateStatus, string> = {
  draft: MUTED,
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  archived: MUTED,
};

export const templateStatusBadgeClass = (status: string): string => TEMPLATE_STATUS_BADGE[status as TemplateStatus] ?? MUTED;

/** The message key (under `Sign.admin.library`) for a template's status. */
export const templateStatusKey = (status: string): string => (TEMPLATE_STATUSES.includes(status as TemplateStatus) ? `statusValue.${status}` : "statusValue.unknown");

/** The links a row offers. The editor and the new-document screen are other screens. */
export const templateEditorHref = (id: string): string => `/sign/templates/${id}`;
export const newDocumentFromTemplateHref = (id: string): string => `/sign/new?templateId=${id}`;
