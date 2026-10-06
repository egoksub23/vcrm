// ============================================================
// Merchant Registration (add-on `merchant`), version 1.1.
//
// What it installs, as drafts to review:
//   * the category "Merchant agreements";
//   * the template "Merchant Application": a 4 page A4 PDF drawn by scripts/build-merchant-template.ts (no
//     real merchant's form is used or copied; it is workspace-neutral and in English with Bahasa Melayu
//     beside it), the placed fields on it, the roles (merchant, optional finance filler, director) and the
//     form (the parts and data fields of Appendix A: company and tax, address and contacts, bank account,
//     documents, commercial terms, review and sign), with wording in English and Bahasa Melayu and labels in
//     Chinese and Korean for the fields that matter.
//
// Nothing here is a legal text. The fees and the nine key terms are headings with a placeholder paragraph
// ("[Insert the agreed wording]") the sender replaces in the template editor; different groups of merchants
// are different templates (duplicate the template). The signing consent stays the workspace's own or the
// product default until the owner has the wording reviewed.
//
// The template file and a summary of its layout are committed in ./merchant/assets/. The layout, the PDF
// and the placements all come from ./merchant/layout.ts, and a test fails if they drift apart.
// ============================================================

import type { AddonManifest } from "./index";
import { MERCHANT_FORM, MERCHANT_ROLES } from "./merchant/form";
import { MERCHANT_PLACEMENTS } from "./merchant/layout";

/** The template file, relative to src/lib/sign/addons/merchant/. */
export const MERCHANT_TEMPLATE_SOURCE = "assets/merchant-application.pdf";

export const merchantAddon: AddonManifest = {
  key: "merchant",
  // 1.1: adds the Merchant Application template and its form (1.0 only had the category)
  version: "1.1",
  nameKey: "merchant.name",
  // not "merchant.description": the 1.0 text said the template was still to come
  descriptionKey: "merchant.about",
  requires: "sign_merchant",
  category: {
    // the same key the starting categories use (sign_ensure_defaults), so a workspace gets one category, not two
    key: "merchant_agreements",
    name: "Merchant agreements",
    description: "Agreements signed by merchants who join.",
    presets: {},
  },
  templates: [
    {
      name: "Merchant Application",
      description: "The application a merchant fills in parts and signs: company and tax, contacts, bank account, documents, commercial terms. Add the agreed fees and terms before use.",
      source: MERCHANT_TEMPLATE_SOURCE,
      roles: MERCHANT_ROLES,
      fields: MERCHANT_PLACEMENTS,
      form: MERCHANT_FORM,
      defaults: { code_required: false, sign_in_order: false, locale: "en", expiry_days: 30, reminder_days: [3, 7] },
      tags: ["merchant", "application", "e-invoice"],
    },
  ],
};
