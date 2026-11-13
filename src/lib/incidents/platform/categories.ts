// A school's own incident categories (migration 220): checking what a school types, making a code for a new category, and working out whether a category can be
// deleted or only hidden. Pure, so the rules are tested; the routes store only what passes.

import { INCIDENT_FLAGS } from "@/lib/incidents/constants";
import type { FormSchema } from "@/lib/incidents/intake/form-schema";
import type { Parsed } from "./pack";

export const MAX_CATEGORIES = 40;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;

export interface CategoryInput {
  name?: string;
  description?: string | null;
  defaultSeverity?: string | null;
  defaultFlags?: string[];
  hidden?: boolean;
}

/**
 * What the school sent for a category. `severities` are the slugs the school's template has. On a new category the name is required; on a change anything
 * can be left out, but something must be sent.
 */
export function parseCategory(body: unknown, opts: { severities: readonly string[]; isNew: boolean }): Parsed<CategoryInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the category." };
  const b = body as Record<string, unknown>;
  const out: CategoryInput = {};

  if (b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
    if (!name) return { ok: false, error: "Give the category a name." };
    if (name.length > MAX_NAME) return { ok: false, error: `The name can be ${MAX_NAME} characters at most.` };
    out.name = name;
  } else if (opts.isNew) {
    return { ok: false, error: "Give the category a name." };
  }

  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== "string") return { ok: false, error: "The description must be text." };
    const description = typeof b.description === "string" ? b.description.trim() : "";
    if (description.length > MAX_DESCRIPTION) return { ok: false, error: `The description can be ${MAX_DESCRIPTION} characters at most.` };
    out.description = description || null;
  }

  if (b.default_severity !== undefined) {
    if (b.default_severity !== null && (typeof b.default_severity !== "string" || !opts.severities.includes(b.default_severity))) {
      return { ok: false, error: "Choose one of the severity levels." };
    }
    out.defaultSeverity = b.default_severity;
  }

  if (b.default_flags !== undefined) {
    if (!Array.isArray(b.default_flags) || b.default_flags.some((f) => typeof f !== "string" || !(INCIDENT_FLAGS as readonly string[]).includes(f))) {
      return { ok: false, error: "Choose from the list of what an incident involves." };
    }
    out.defaultFlags = [...new Set(b.default_flags as string[])];
  }

  if (b.hidden !== undefined) {
    if (typeof b.hidden !== "boolean") return { ok: false, error: "Say whether the category is hidden." };
    out.hidden = b.hidden;
  }

  if (Object.keys(out).length === 0) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: out };
}

/**
 * A short code for a new category, from its name: the initials of a few words ("Lab safety incident" is LSI), or the first letters of one word ("Fire" is FIR).
 * It is never the same as one already taken, and it never changes after that, so renaming a category does not break the rules and forms that point at it.
 */
export function makeCode(name: string, taken: Iterable<string>): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let base = words.length >= 2 ? words.slice(0, 4).map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3);
  if (base.length < 2) base = (base + "CAT").slice(0, 3);
  const used = new Set([...taken].map((c) => c.toUpperCase()));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
  return `${base}${used.size + 1}`;
}

/** Where the school's own copy is stored: a name and a slug that cannot clash with another school's. */
export const copyName = (name: string) => `${name} (our copy)`.slice(0, 120);
export const copySlug = (accountId: string) => `school_incident_${accountId.replace(/-/g, "")}`;

// ---- what uses a category -----------------------------------------------------------------------------------------------------

export interface Usage {
  incidents: number;
  rules: number;
  forms: number;
}

/** The category codes a notification rule's conditions name. */
export function ruleCategoryCodes(conditions: unknown): string[] {
  const c = (conditions as { categories?: unknown } | null)?.categories;
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === "string") : [];
}

/** The category codes a report form files under (what each choice sets the incident's category to). */
export function formCategoryCodes(schema: FormSchema | null | undefined): string[] {
  if (!schema?.steps) return [];
  return schema.steps.flatMap((s) => s.fields).flatMap((f) => (f.options ?? []).map((o) => o.effects?.category)).filter((c): c is string => Boolean(c));
}

export function usageOf(code: string, data: { incidentTypes: readonly string[]; ruleCategories: readonly (readonly string[])[]; formCategories: readonly (readonly string[])[] }): Usage {
  return {
    incidents: data.incidentTypes.filter((t) => t === code).length,
    rules: data.ruleCategories.filter((cats) => cats.includes(code)).length,
    forms: data.formCategories.filter((cats) => cats.includes(code)).length,
  };
}

/** A category can be deleted only when nothing points at it; otherwise it can be hidden. */
export const canDelete = (u: Usage): boolean => u.incidents === 0 && u.rules === 0 && u.forms === 0;

/** The sentence that says why a category cannot be deleted, or null when it can. */
export function whyNotDeletable(u: Usage): string | null {
  if (canDelete(u)) return null;
  const parts: string[] = [];
  if (u.incidents) parts.push(`${u.incidents} ${u.incidents === 1 ? "incident uses" : "incidents use"} it`);
  if (u.rules) parts.push(`${u.rules} ${u.rules === 1 ? "notification rule names" : "notification rules name"} it`);
  if (u.forms) parts.push(`the report form files under it`);
  return `${parts.join(", ")}. Hide it instead: it stops appearing on the raise form and nothing else changes.`;
}
