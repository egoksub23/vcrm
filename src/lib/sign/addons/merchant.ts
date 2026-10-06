// ============================================================
// Merchant Registration (add-on `merchant`), version 1.0.
//
// Today it installs the category "Merchant agreements". The Merchant Application template, the form and
// the contact fields come in a later work package (their files are not in the code base yet), so
// `templates` is empty and the card says "Templates are added in a later update". Nothing here is a
// legal text: the signing consent stays the workspace's own or the product default until the owner has
// the wording reviewed.
// ============================================================

import type { AddonManifest } from "./index";

export const merchantAddon: AddonManifest = {
  key: "merchant",
  version: "1.0",
  nameKey: "merchant.name",
  descriptionKey: "merchant.description",
  requires: "sign_merchant",
  category: {
    // the same key the starting categories use (sign_ensure_defaults), so a workspace gets one category, not two
    key: "merchant_agreements",
    name: "Merchant agreements",
    description: "Agreements signed by merchants who join.",
    presets: {},
  },
  templates: [],
};
