// ============================================================
// Add-on roles (migration 191), the screen's pure rules: what a draft changes, what a person may add, and the body a save sends. No React, no I/O, so each is
// tested without a browser. A person's add-on role only ADDS to their base role.
// ============================================================

import { CAPABILITIES, type CapabilityDef } from '@/lib/auth/capabilities';

export interface AddonDraft {
  name: string;
  description: string;
  capabilities: ReadonlySet<string>;
}

/** The permission keys of a saved add-on that still exist in the catalogue. */
export function savedAddonSet(keys: readonly string[] | undefined): Set<string> {
  const known = new Set(CAPABILITIES.map((c) => c.key));
  return new Set((keys ?? []).filter((k) => known.has(k)));
}

/** How many things differ between the saved add-on and the draft: the name, the description, and each permission added or removed. */
export function addonChangeCount(saved: AddonDraft, draft: AddonDraft): number {
  let n = 0;
  if (saved.name.trim() !== draft.name.trim()) n += 1;
  if (saved.description.trim() !== draft.description.trim()) n += 1;
  for (const k of draft.capabilities) if (!saved.capabilities.has(k)) n += 1;
  for (const k of saved.capabilities) if (!draft.capabilities.has(k)) n += 1;
  return n;
}

/**
 * The body a save sends: only what changed. `capabilities` is the WHOLE new set, sent only when it differs. Returns null when nothing changed or when
 * the draft has no usable name.
 */
export function addonSaveBody(saved: AddonDraft, draft: AddonDraft): { name?: string; description?: string; capabilities?: string[] } | null {
  if (draft.name.trim() === '') return null;
  const body: { name?: string; description?: string; capabilities?: string[] } = {};
  if (saved.name.trim() !== draft.name.trim()) body.name = draft.name.trim();
  if (saved.description.trim() !== draft.description.trim()) body.description = draft.description.trim();
  const same = saved.capabilities.size === draft.capabilities.size && [...draft.capabilities].every((k) => saved.capabilities.has(k));
  if (!same) body.capabilities = CAPABILITIES.map((c) => c.key).filter((k) => draft.capabilities.has(k));
  return Object.keys(body).length === 0 ? null : body;
}

/**
 * Why a permission's switch cannot be turned ON: you can only put a permission in an add-on when you hold it yourself. Turning one OFF is always allowed
 * (taking a permission out needs none), so a permission already in the role stays switchable by someone who does not hold it.
 */
export function addonSwitchBlocked(cap: Pick<CapabilityDef, 'key'>, on: boolean, editorCaps: ReadonlySet<string>): 'not-held' | null {
  if (on) return null;
  return editorCaps.has(cap.key) ? null : 'not-held';
}
