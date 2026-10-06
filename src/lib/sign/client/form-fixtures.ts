// A small merchant-application-like form for the form builder's tests (not used by the screens).

import type { FormDefinition, L10n } from "../forms/types";
import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import type { FormSeeds } from "./form-edit";

export const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });

export const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "finance", label: "Finance", kind: "filler", color: 1 },
];

export const seeds: FormSeeds = {
  newPart: "New part",
  newField: "New field",
  option: (n) => `Option ${n}`,
  acknowledgeText: "I have read and agree.",
  copySuffix: " (copy)",
};

export const sampleForm = (): FormDefinition => ({
  version: 1,
  parts: [
    { key: "company", title: L("Company"), role: "merchant" },
    { key: "tax", title: L("Tax"), role: "merchant" },
    { key: "bank", title: L("Bank"), role: "finance" },
  ],
  fields: [
    { key: "legal_name", type: "text", part: "company", label: L("Legal name"), required: true },
    { key: "biz_type", type: "choice", part: "company", label: L("Type"), required: true, options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.") }, { value: "sole", label: L("Sole proprietor") }] },
    { key: "tax_type", type: "choice", part: "tax", label: L("Tax type"), required: false, options: [{ value: "sst", label: L("SST") }, { value: "na", label: L("Not applicable") }] },
    { key: "tax_pct", type: "number", part: "tax", label: L("Tax percentage", "Peratusan cukai"), required: false, requiredIf: { op: "eq", field: "tax_type", value: "sst" }, visibleIf: { op: "eq", field: "tax_type", value: "sst" }, min: 0, max: 100 },
    { key: "msic", type: "list", part: "tax", label: L("MSIC codes"), required: true, itemFormat: "digits", itemLength: 5 },
    { key: "account_no", type: "text", part: "bank", label: L("Account number"), required: true, format: "digits", visibleIf: { op: "and", rules: [{ op: "notEmpty", field: "legal_name" }, { op: "ne", field: "biz_type", value: "sole" }] } },
    { key: "form9", type: "file", part: "bank", label: L("Form 9"), required: true, accept: ["pdf"], maxMb: 5, maxFiles: 1 },
  ],
});

export const placement = (over: Partial<PlacedField> & { key: string }): PlacedField => ({ type: "text", role: "sender", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.03, required: false, ...over });

export const placements: PlacedField[] = [
  { key: "f_sig", type: "signature", role: "merchant", page: 1, x: 0.1, y: 0.8, w: 0.26, h: 0.05, required: true },
  placement({ key: "p_name", data: "legal_name" }),
  placement({ key: "p_name2", data: "legal_name", page: 1, y: 0.2 }),
  placement({ key: "p_sst", type: "checkbox", data: "tax_type", dataValue: "sst", page: 1, y: 0.4, w: 0.03, h: 0.03 }),
  placement({ key: "p_pct", type: "number", data: "tax_pct", page: 1, y: 0.5 }),
];
