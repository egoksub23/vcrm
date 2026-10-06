// ============================================================
// Installing a Doc Sign add-on into a workspace, and listing the catalogue with each add-on's state.
//
//   * Safe to repeat. A second press adds only what is missing and changes nothing the workspace has.
//   * The category is created if missing (marked with the add-on's key). A category with the same key that
//     the workspace already has (the starting "Merchant agreements", say) is kept as it is: its presets are
//     never overwritten, it is only marked as belonging to the add-on, and un-archived if it was archived.
//   * Each template is created as a DRAFT to review. A template of the same name that already exists for the
//     add-on is skipped, edited or not ("customised" ones are never touched).
//   * The installed version is recorded in `sign_addons` once everything above worked.
//
// The audit log is written by the database: triggers on sign_addons, sign_categories and sign_templates
// (migration 157) record each row this creates, with the person in `installed_by` / `created_by`.
//
// What it cannot do: PostgREST has no transaction across calls, so this is a sequence of safe, repeatable
// steps rather than one transaction. A failure part way leaves the steps already done in place and records
// nothing in sign_addons, so pressing Install again finishes the job.
// ============================================================

import { readFile } from "node:fs/promises";
import path from "node:path";

import { signEnabled, signMerchantEnabled } from "../feature";
import { SignError, raiseDatabaseError } from "../service/errors";
import type { SignCtx } from "../service/context";
import { createTemplateFromUpload, saveTemplateVersion } from "../service/templates";
import { ADDON_REGISTRY, getAddon, installableTemplates, listAddons, type AddonManifest, type AddonRegistry } from "./index";

export interface InstallOptions {
  registry?: AddonRegistry;
  /** Read a template's source file. The default reads it from `src/lib/sign/addons/<key>/`. */
  readSource?: (addonKey: string, relativePath: string) => Promise<Uint8Array>;
}

export type CategoryOutcome = "created" | "adopted" | "restored" | "existing";

export interface InstallResult {
  key: string;
  version: string;
  /** The version that was recorded before this call, or null when this is the first install. */
  previousVersion: string | null;
  category: { key: string; outcome: CategoryOutcome };
  templates: { created: string[]; skipped: string[] };
}

/** May this workspace use the add-on? The operator's flag, and Doc Sign itself being on. */
export async function addonAllowed(ctx: Pick<SignCtx, "admin" | "accountId">, manifest: AddonManifest): Promise<boolean> {
  return manifest.requires === "sign_merchant" ? signMerchantEnabled(ctx.admin, ctx.accountId) : signEnabled(ctx.admin, ctx.accountId);
}

async function defaultReadSource(addonKey: string, relativePath: string): Promise<Uint8Array> {
  const base = path.resolve(process.cwd(), "src", "lib", "sign", "addons", addonKey);
  const full = path.resolve(base, relativePath);
  // a manifest is code we wrote, but a path that climbs out of the add-on's folder is a mistake either way
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("template source path leaves the add-on folder");
  return new Uint8Array(await readFile(full));
}

interface CategoryRow {
  id: string;
  key: string;
  addon_key: string | null;
  archived: boolean;
  position: number;
}

async function ensureCategory(ctx: SignCtx, m: AddonManifest): Promise<{ row: CategoryRow; outcome: CategoryOutcome }> {
  const found = await ctx.admin.from("sign_categories").select("id, key, addon_key, archived, position").eq("account_id", ctx.accountId).eq("key", m.category.key).maybeSingle();
  if (found.error) raiseDatabaseError(found.error, "load add-on category");
  if (found.data) {
    const row = found.data as CategoryRow;
    const patch: Record<string, unknown> = {};
    if (!row.addon_key) patch.addon_key = m.key;
    if (row.archived) patch.archived = false;
    if (Object.keys(patch).length === 0) return { row, outcome: "existing" };
    const u = await ctx.admin.from("sign_categories").update(patch).eq("id", row.id).eq("account_id", ctx.accountId).select("id, key, addon_key, archived, position").single();
    if (u.error || !u.data) raiseDatabaseError(u.error, "mark add-on category");
    return { row: u.data as CategoryRow, outcome: row.archived ? "restored" : "adopted" };
  }

  const last = await ctx.admin.from("sign_categories").select("position").eq("account_id", ctx.accountId).order("position", { ascending: false }).limit(1);
  if (last.error) raiseDatabaseError(last.error, "load category positions");
  const position = ((last.data as { position: number }[] | null)?.[0]?.position ?? 0) + 1;
  const p = m.category.presets;
  const ins = await ctx.admin
    .from("sign_categories")
    .insert({
      account_id: ctx.accountId,
      key: m.category.key,
      name: m.category.name,
      description: m.category.description ?? null,
      expiry_days: p.expiryDays ?? null,
      reminder_days: p.reminderDays ?? null,
      code_required: p.codeRequired ?? false,
      sign_in_order: p.signInOrder ?? false,
      retention_years: p.retentionYears ?? null,
      consent_text: m.category.consentText ?? null,
      addon_key: m.key,
      archived: false,
      position,
    })
    .select("id, key, addon_key, archived, position")
    .single();
  if (ins.error || !ins.data) {
    // someone created it at the same moment: take theirs
    const again = await ctx.admin.from("sign_categories").select("id, key, addon_key, archived, position").eq("account_id", ctx.accountId).eq("key", m.category.key).maybeSingle();
    if (again.data) return { row: again.data as CategoryRow, outcome: "existing" };
    raiseDatabaseError(ins.error, "create add-on category");
  }
  return { row: ins.data as CategoryRow, outcome: "created" };
}

/** Install (or repeat the install of) an add-on for the workspace. */
export async function installAddon(ctx: SignCtx, key: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const registry = opts.registry ?? ADDON_REGISTRY;
  const manifest = getAddon(key, registry);
  if (!manifest) throw new SignError("addon_not_found", "That add-on does not exist.", 404);
  if (!(await addonAllowed(ctx, manifest))) {
    throw new SignError("addon_not_available", "This add-on is not available for your workspace. Ask the platform operator to switch it on.", 403);
  }
  const readSource = opts.readSource ?? defaultReadSource;

  const before = await ctx.admin.from("sign_addons").select("installed_version, status").eq("account_id", ctx.accountId).eq("addon_key", manifest.key).maybeSingle();
  if (before.error) raiseDatabaseError(before.error, "load add-on state");
  const previous = before.data as { installed_version: string; status: string } | null;

  const { row: category, outcome } = await ensureCategory(ctx, manifest);

  const existing = await ctx.admin.from("sign_templates").select("id, name").eq("account_id", ctx.accountId).eq("addon_key", manifest.key);
  if (existing.error) raiseDatabaseError(existing.error, "load add-on templates");
  const have = new Set(((existing.data ?? []) as { name: string }[]).map((t) => t.name.trim().toLowerCase()));

  const created: string[] = [];
  const skipped: string[] = [];
  for (const def of installableTemplates(manifest)) {
    if (have.has(def.name.trim().toLowerCase())) {
      skipped.push(def.name);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readSource(manifest.key, def.source as string);
    } catch (err) {
      console.error(`[sign] add-on ${manifest.key}: cannot read ${def.source}:`, err instanceof Error ? err.message : err);
      throw new SignError("addon_source_missing", "A file this add-on needs is missing from the server. Please contact support.", 500);
    }
    const { template } = await createTemplateFromUpload(ctx, { bytes, filename: path.basename(def.source as string), name: def.name, categoryId: category.id });
    // The layout goes in as the next version, before the template is marked as the add-on's (saving a
    // version of an add-on's template marks it customised, which this is not).
    if (def.fields.length > 0 || def.roles.length > 0) {
      await saveTemplateVersion(ctx, template.id, { fields: def.fields, roles: def.roles, defaults: def.defaults });
    }
    const mark = await ctx.admin
      .from("sign_templates")
      .update({ addon_key: manifest.key, addon_version: manifest.version, customised: false, description: def.description ?? null, tags: def.tags ?? [] })
      .eq("id", template.id)
      .eq("account_id", ctx.accountId);
    if (mark.error) raiseDatabaseError(mark.error, "mark add-on template");
    created.push(def.name);
  }

  const record = await ctx.admin
    .from("sign_addons")
    .upsert({ account_id: ctx.accountId, addon_key: manifest.key, installed_version: manifest.version, status: "installed", installed_by: ctx.userId }, { onConflict: "account_id,addon_key" });
  if (record.error) raiseDatabaseError(record.error, "record add-on");

  return {
    key: manifest.key,
    version: manifest.version,
    previousVersion: previous?.status === "installed" ? previous.installed_version : null,
    category: { key: manifest.category.key, outcome },
    templates: { created, skipped },
  };
}

// ---- the catalogue ------------------------------------------------------------------------------

export interface AddonCard {
  key: string;
  version: string;
  nameKey: string;
  descriptionKey: string;
  requires: AddonManifest["requires"];
  /** The operator allows this workspace to install it. */
  available: boolean;
  installed: { version: string; installedAt: string } | null;
  /** A newer version than the installed one exists (applying updates is a later update). */
  updateAvailable: boolean;
  category: { key: string; name: string };
  /** Templates that install now, and templates announced but not shipped yet. */
  templates: { installable: number; announced: number };
}

export async function listAddonCards(ctx: Pick<SignCtx, "admin" | "accountId">, registry: AddonRegistry = ADDON_REGISTRY): Promise<AddonCard[]> {
  const rows = await ctx.admin.from("sign_addons").select("addon_key, installed_version, installed_at, status").eq("account_id", ctx.accountId);
  if (rows.error) raiseDatabaseError(rows.error, "load installed add-ons");
  const installedByKey = new Map(((rows.data ?? []) as { addon_key: string; installed_version: string; installed_at: string; status: string }[]).filter((r) => r.status === "installed").map((r) => [r.addon_key, r]));
  const cards: AddonCard[] = [];
  for (const m of listAddons(registry)) {
    const inst = installedByKey.get(m.key);
    cards.push({
      key: m.key,
      version: m.version,
      nameKey: m.nameKey,
      descriptionKey: m.descriptionKey,
      requires: m.requires,
      available: await addonAllowed(ctx, m),
      installed: inst ? { version: inst.installed_version, installedAt: inst.installed_at } : null,
      updateAvailable: !!inst && inst.installed_version !== m.version,
      category: { key: m.category.key, name: m.category.name },
      templates: { installable: installableTemplates(m).length, announced: m.templates.length - installableTemplates(m).length },
    });
  }
  return cards;
}
