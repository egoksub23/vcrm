// ============================================================
// Updating an installed add-on to its newest version (F-81). Settings > Doc Sign > Add-ons shows "Update available" with what changed
// (the manifest's `changes`) and an Update button that calls this.
//
// The safest rule, applied template by template (an add-on's template is found by its name, as the installer does):
//
//   already current   a template of the add-on is already at the manifest's version: nothing to do (this is also what makes pressing
//                     Update twice harmless).
//   not edited        the template's content still equals a version the add-on shipped before (fingerprint.ts): it gets a NEW
//                     VERSION with the new layout, form and defaults, made current. Its name, status, category and everything the
//                     workspace set on it stay. Earlier versions stay in its history.
//   edited            the content is not what any shipped version contained, or the file the add-on ships is not the file the
//                     template has: the workspace's template is left exactly as it is, and a NEW template "<name> (updated)" is made
//                     next to it from the add-on's current version, as a draft to review. The administrator is told which.
//   missing           the workspace deleted the template: nothing is recreated (Install again does that).
//
// Documents already sent keep their own frozen copy of what they were sent with, and drafts keep theirs: nothing here touches a
// document. A new copy and a new version are made through the same services as anything else (checks included), so an update that
// would store an unsound form fails before the version is recorded and a second try repeats it.
//
// Audit: the database logs the change of `sign_addons.installed_version` (who, from which version, to which) and every template
// created (migration 157's triggers). The new versions of templates are rows of their own.
//
// Nothing is recorded in `sign_addons` until every template has been dealt with, so a failure part way is finished by pressing
// Update again (what was done is "already current").
// ============================================================

import { sha256Hex } from "../pdf/load";
import { loadSettings, type SignCtx } from "../service/context";
import { SignError, raiseDatabaseError } from "../service/errors";
import { saveTemplateVersion } from "../service/templates";
import type { SignTemplateVersionRow } from "../types";
import { equalsAny } from "./fingerprint";
import { ADDON_REGISTRY, compareVersions, getAddon, installableTemplates, type AddonManifest, type AddonRegistry, type AddonTemplateDef, type AddonTemplateShape } from "./index";
import { addonAllowed, createAddonTemplate, defaultReadSource, ensureCategory, type InstallOptions } from "./install";

export type TemplateOutcome =
  | { name: string; outcome: "updated"; versionNo: number }
  | { name: string; outcome: "copied"; copyName: string }
  | { name: string; outcome: "current" }
  | { name: string; outcome: "missing" };

export interface UpdateResult {
  key: string;
  fromVersion: string;
  toVersion: string;
  /** Already on the newest version: nothing was done. */
  upToDate: boolean;
  templates: TemplateOutcome[];
}

interface TemplateRow {
  id: string;
  name: string;
  addon_version: string | null;
  current_version_id: string | null;
  created_at?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/** The name a copy gets: "<name> (updated)", then "(updated 2)", "(updated 3)"... until it is free. */
export function copyName(base: string, taken: ReadonlySet<string>): string {
  const first = `${base} (updated)`;
  if (!taken.has(norm(first))) return first;
  for (let n = 2; n < 1000; n++) {
    const next = `${base} (updated ${n})`;
    if (!taken.has(norm(next))) return next;
  }
  return `${base} (updated ${Date.now()})`;
}

/** The templates of the add-on that belong to this definition: the one with its name, and the copies earlier updates made. */
function ownedBy(def: AddonTemplateDef, rows: readonly TemplateRow[]): TemplateRow[] {
  const base = norm(def.name);
  return rows.filter((r) => norm(r.name) === base || norm(r.name).startsWith(`${base} (updated`));
}

/** Every shape the add-on has shipped for this template before the current version. */
function shippedShapes(manifest: AddonManifest, def: AddonTemplateDef): AddonTemplateShape[] {
  return (manifest.history ?? []).flatMap((h) => h.templates.filter((t) => norm(t.name) === norm(def.name)));
}

async function loadVersion(ctx: SignCtx, id: string): Promise<SignTemplateVersionRow> {
  const { data, error } = await ctx.admin.from("sign_template_versions").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
  if (error || !data) raiseDatabaseError(error, "load template version");
  return data as SignTemplateVersionRow;
}

export async function updateAddon(ctx: SignCtx, key: string, opts: InstallOptions = {}): Promise<UpdateResult> {
  const registry: AddonRegistry = opts.registry ?? ADDON_REGISTRY;
  const manifest = getAddon(key, registry);
  if (!manifest) throw new SignError("addon_not_found", "That add-on does not exist.", 404);
  if (!(await addonAllowed(ctx, manifest))) {
    throw new SignError("addon_not_available", "This add-on is not available for your workspace. Ask the platform operator to switch it on.", 403);
  }
  const readSource = opts.readSource ?? defaultReadSource;

  const state = await ctx.admin.from("sign_addons").select("installed_version, status").eq("account_id", ctx.accountId).eq("addon_key", manifest.key).maybeSingle();
  if (state.error) raiseDatabaseError(state.error, "load add-on state");
  const installed = state.data as { installed_version: string; status: string } | null;
  if (!installed || installed.status !== "installed") throw new SignError("addon_not_installed", "Install this add-on first.", 409);
  if (compareVersions(installed.installed_version, manifest.version) >= 0) {
    return { key: manifest.key, fromVersion: installed.installed_version, toVersion: installed.installed_version, upToDate: true, templates: [] };
  }

  // the workspace's lists exist before a form that names them is stored (the same read the template service does, made once, early)
  await loadSettings(ctx);
  const { row: category } = await ensureCategory(ctx, manifest);
  const all = await ctx.admin.from("sign_templates").select("id, name, addon_version, current_version_id, created_at").eq("account_id", ctx.accountId).eq("addon_key", manifest.key);
  if (all.error) raiseDatabaseError(all.error, "load add-on templates");
  const rows = ((all.data ?? []) as TemplateRow[]).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  const taken = new Set(((await ctx.admin.from("sign_templates").select("name").eq("account_id", ctx.accountId)).data ?? ([] as { name: string }[])).map((r: { name: string }) => norm(r.name)));

  const outcomes: TemplateOutcome[] = [];
  for (const def of installableTemplates(manifest)) {
    const mine = ownedBy(def, rows);
    if (mine.some((r) => r.addon_version && compareVersions(r.addon_version, manifest.version) >= 0)) {
      outcomes.push({ name: def.name, outcome: "current" });
      continue;
    }
    // the template with the add-on's own name; if the workspace renamed it, the oldest one of the add-on's
    const original = mine.find((r) => norm(r.name) === norm(def.name)) ?? mine[0];
    if (!original || !original.current_version_id) {
      outcomes.push({ name: def.name, outcome: "missing" });
      continue;
    }
    const version = await loadVersion(ctx, original.current_version_id);
    const bytes = await readSource(manifest.key, def.source as string).catch((err) => {
      console.error(`[sign] add-on ${manifest.key}: cannot read ${def.source}:`, err instanceof Error ? err.message : err);
      throw new SignError("addon_source_missing", "A file this add-on needs is missing from the server. Please contact support.", 500);
    });
    const sameFile = sha256Hex(bytes) === version.source_sha256;
    const untouched = sameFile && equalsAny({ roles: version.roles, fields: version.fields, defaults: version.defaults, form: version.form }, shippedShapes(manifest, def));

    if (untouched) {
      const saved = await saveTemplateVersion(ctx, original.id, { fields: def.fields, roles: def.roles, defaults: def.defaults, ...(def.form ? { form: def.form } : {}) });
      // saving a version of an add-on's template marks it customised; this is the add-on's own change, not the workspace's
      const mark = await ctx.admin.from("sign_templates").update({ addon_version: manifest.version, customised: false }).eq("id", original.id).eq("account_id", ctx.accountId);
      if (mark.error) raiseDatabaseError(mark.error, "mark add-on template");
      outcomes.push({ name: def.name, outcome: "updated", versionNo: saved.version.version_no });
    } else {
      const name = copyName(def.name, taken);
      taken.add(norm(name));
      await createAddonTemplate(ctx, manifest, def, category.id, readSource, name);
      outcomes.push({ name: def.name, outcome: "copied", copyName: name });
    }
  }

  // recorded last: the database logs the change of version with who made it (migration 157's trigger on sign_addons)
  const record = await ctx.admin.from("sign_addons").update({ installed_version: manifest.version, installed_by: ctx.userId }).eq("account_id", ctx.accountId).eq("addon_key", manifest.key);
  if (record.error) raiseDatabaseError(record.error, "record add-on update");
  return { key: manifest.key, fromVersion: installed.installed_version, toVersion: manifest.version, upToDate: false, templates: outcomes };
}
