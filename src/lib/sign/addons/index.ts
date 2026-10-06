// ============================================================
// Doc Sign add-ons: ready-made packs for a business process (docs/vircle-sign-plan.md, section 7).
//
// An add-on is defined here, in the code base, and versioned. It can carry a category with its presets,
// templates (a source file and the fields, roles and defaults to put on it) and wording per language.
// Which workspaces may install it is the operator's switch (a platform flag, `requires`); installing is
// done by a workspace Owner or Admin (install.ts). Pure data and lookups: no I/O in this file.
//
// A template's source file lives beside its manifest, in `src/lib/sign/addons/<key>/`, and is named in
// the manifest by a path relative to that folder. A template with `source: null` is announced but not
// installed yet (the card says so).
// ============================================================

import type { FormDefinition } from "../forms/types";
import type { PlacedField } from "../pdf/types";
import type { SignLocale, SignRole, TemplateDefaults } from "../types";
import { merchantAddon } from "./merchant";

/** The platform flag the operator must have on for a workspace before it may install the add-on. */
export type AddonRequirement = "sign" | "sign_merchant";

export interface AddonCategoryDef {
  /** Becomes the category's key: lower case letters, digits and `_`. Stays the same across versions. */
  key: string;
  name: string;
  description?: string;
  /** What a new document in the category starts with. Absent means "use the workspace setting". */
  presets: {
    expiryDays?: number;
    reminderDays?: number[];
    codeRequired?: boolean;
    signInOrder?: boolean;
    retentionYears?: number;
  };
  /** Wording the signer agrees to, per language. Absent means the workspace's own or the product default. */
  consentText?: Partial<Record<SignLocale, string>>;
}

export interface AddonTemplateDef {
  /** The name of the draft template that is created. An existing template of the same name is left alone. */
  name: string;
  description?: string;
  /** Path relative to `src/lib/sign/addons/<key>/` (a PDF or Word file), or null when it is not shipped yet. */
  source: string | null;
  roles: SignRole[];
  fields: PlacedField[];
  defaults: TemplateDefaults;
  /** Forms (phase 1B): the parts and data fields the signers fill. Stored on the template's first version. */
  form?: FormDefinition;
  tags?: string[];
}

/**
 * What a version of the add-on changed, in words an administrator reads before pressing Update: a few plain sentences per language
 * (English and Bahasa Melayu always, Chinese and Korean where the wording is confident; a missing language reads in English).
 */
export interface AddonChange {
  version: string;
  items: Partial<Record<SignLocale, string[]>> & { en: string[] };
}

/** What a template contained in a version that was shipped before: how an update tells a template nobody edited from one that was edited. */
export interface AddonTemplateShape {
  name: string;
  roles: SignRole[];
  fields: PlacedField[];
  defaults: TemplateDefaults;
  form?: FormDefinition;
}

/** A version of the add-on that has been shipped and replaced, with its templates as they were. Kept so that an update can recognise them. */
export interface AddonHistoryEntry {
  version: string;
  templates: AddonTemplateShape[];
}

export interface AddonManifest {
  /** `^[a-z][a-z0-9_]{1,40}$`: it is stored in `sign_addons.addon_key`. */
  key: string;
  /**
   * "major.minor", for example "2.0". Recorded when installed, and compared as numbers (`compareVersions`) so "1.10" is newer than "1.9".
   * Raise it whenever the templates change, add an entry to `changes` for it, and move the version it replaces into `history`.
   */
  version: string;
  /** Message keys under `Sign.admin.addons`: the card name and its one-line description. */
  nameKey: string;
  descriptionKey: string;
  requires: AddonRequirement;
  category: AddonCategoryDef;
  templates: AddonTemplateDef[];
  /** What each version changed, newest last. An update shows the entries newer than the version the workspace has. */
  changes?: AddonChange[];
  /** The earlier versions' templates (see AddonHistoryEntry): an update replaces a template only when it still equals one of these. */
  history?: AddonHistoryEntry[];
}

/** Compare two "major.minor" versions as numbers: negative when `a` is older, 0 when equal, positive when `a` is newer. Anything unreadable counts as 0.0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const [maj, min] = v.split(".");
    return [Number.parseInt(maj ?? "", 10) || 0, Number.parseInt(min ?? "", 10) || 0] as const;
  };
  const [a1, a2] = parts(a);
  const [b1, b2] = parts(b);
  return a1 - b1 || a2 - b2;
}

/** The entries of `changes` that a workspace on `installed` has not had yet, oldest first, up to and including the current version. */
export function changesSince(m: AddonManifest, installed: string): AddonChange[] {
  return (m.changes ?? []).filter((c) => compareVersions(c.version, installed) > 0 && compareVersions(c.version, m.version) <= 0).sort((x, y) => compareVersions(x.version, y.version));
}

export const ADDON_REGISTRY: Record<string, AddonManifest> = {
  [merchantAddon.key]: merchantAddon,
};

export type AddonRegistry = Record<string, AddonManifest>;

export function listAddons(registry: AddonRegistry = ADDON_REGISTRY): AddonManifest[] {
  return Object.values(registry);
}

export function getAddon(key: string, registry: AddonRegistry = ADDON_REGISTRY): AddonManifest | null {
  return Object.prototype.hasOwnProperty.call(registry, key) ? registry[key] : null;
}

/** The templates of an add-on that have a file to install now. */
export const installableTemplates = (m: AddonManifest): AddonTemplateDef[] => m.templates.filter((t) => t.source !== null);
