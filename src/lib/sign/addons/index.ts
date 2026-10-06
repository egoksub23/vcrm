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
  tags?: string[];
}

export interface AddonManifest {
  /** `^[a-z][a-z0-9_]{1,40}$`: it is stored in `sign_addons.addon_key`. */
  key: string;
  /** Semantic version, "1.0". Recorded when installed. */
  version: string;
  /** Message keys under `Sign.admin.addons`: the card name and its one-line description. */
  nameKey: string;
  descriptionKey: string;
  requires: AddonRequirement;
  category: AddonCategoryDef;
  templates: AddonTemplateDef[];
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
