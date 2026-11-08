// Reads for the Categories page (server side): the school's active template, whether it is the school's own copy, and what uses each category.

import { CCA_FORM, type FormSchema } from "@/lib/incidents/intake/form-schema";
import type { PgDb } from "@/lib/postgres/db";
import { formCategoryCodes, ruleCategoryCodes, usageOf, type Usage } from "./categories";
import { loadActiveTemplate } from "./setup-data";

export interface CategoryRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_severity: string | null;
  default_flags: string[];
  is_hidden: boolean;
  position: number;
  usage: Usage;
}

export interface CategoriesView {
  template: { id: string; name: string; ownCopy: boolean };
  severities: { slug: string; label: string }[];
  categories: CategoryRow[];
}

/** The school's active template with each category's usage; null when the school has no template. */
export async function loadCategoriesView(db: PgDb, accountId: string): Promise<CategoriesView | null> {
  const tpl = await loadActiveTemplate(db, accountId);
  if (!tpl) return null;
  const { data: std } = await db.from("incident_standards").select("account_id").eq("id", tpl.standardId).maybeSingle();
  const ownCopy = (std as { account_id: string | null } | null)?.account_id === accountId;

  const [incidents, rules, forms] = await Promise.all([
    db.from("incidents").select("incident_type").eq("account_id", accountId).limit(50000),
    db.from("incident_rules").select("conditions").eq("account_id", accountId).limit(1000),
    db.from("incident_form_versions").select("schema").eq("account_id", accountId).limit(200),
  ]);
  const incidentTypes = ((incidents.data ?? []) as { incident_type: string }[]).map((r) => r.incident_type);
  const ruleCategories = ((rules.data ?? []) as { conditions: unknown }[]).map((r) => ruleCategoryCodes(r.conditions));
  // The form built into Halo files under its own categories until the school publishes a form; count it either way, so a category it needs is never deleted.
  const formCategories = [formCategoryCodes(CCA_FORM), ...((forms.data ?? []) as { schema: FormSchema }[]).map((f) => formCategoryCodes(f.schema))];

  return {
    template: { id: tpl.standardId, name: tpl.name, ownCopy },
    severities: tpl.severities.map((s) => ({ slug: s.slug, label: s.label })),
    categories: tpl.categories.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      description: c.description,
      default_severity: c.default_severity,
      default_flags: c.default_flags ?? [],
      is_hidden: (c as { is_hidden?: boolean }).is_hidden === true,
      position: c.position,
      usage: usageOf(c.code, { incidentTypes, ruleCategories, formCategories }),
    })),
  };
}
