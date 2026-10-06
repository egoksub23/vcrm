// ============================================================
// Doc Sign forms, the send flow: what the sender needs to know before sending a document that carries a form.
// Which parts each role completes and whether that role also signs ("Merchant: parts 1 to 4 and signs", "Finance:
// part 5, fills only"), which parts have nobody to complete them (a blocking problem), and whether the form will
// start filled in from the linked contact. Pure.
// ============================================================

import { pick } from "../forms/text";
import type { DataField, FormDefinition } from "../forms/types";
import type { SignLocale, SignRole, SignerKind } from "../types";
import type { SignerRow } from "./signers-form";

export interface FormPartLine {
  key: string;
  /** 1-based position in the form. */
  number: number;
  title: string;
  roleKey: string;
  roleLabel: string;
  /** The role's colour slot (0 to 5), or null when the role is unknown. */
  color: number | null;
  fieldCount: number;
  requiredCount: number;
}

/** Every part of the form, in order, with who completes it and how many fields it asks. */
export function formPartLines(form: FormDefinition, roles: readonly SignRole[], locale: SignLocale): FormPartLine[] {
  return form.parts.map((p, i) => {
    const role = roles.find((r) => r.key === p.role);
    const fields = form.fields.filter((f) => f.part === p.key);
    return {
      key: p.key,
      number: i + 1,
      title: pick(p.title, locale) || p.key,
      roleKey: p.role,
      roleLabel: role?.label ?? p.role,
      color: role ? role.color : null,
      fieldCount: fields.length,
      requiredCount: fields.filter((f) => f.required).length,
    };
  });
}

/** Runs of three or more consecutive numbers collapse to a range ("1 to 4"); shorter runs stay as single numbers. */
export function partRanges(numbers: readonly number[]): { from: number; to: number }[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out: { from: number; to: number }[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) out.push({ from: sorted[i], to: sorted[j] });
    else for (let k = i; k <= j; k++) out.push({ from: sorted[k], to: sorted[k] });
    i = j + 1;
  }
  return out;
}

export type HoldMode = "partsSign" | "partsFill" | "signOnly" | "nothing";

export interface RoleHolds {
  roleKey: string;
  roleLabel: string;
  color: number;
  kind: SignerKind;
  partCount: number;
  ranges: { from: number; to: number }[];
  /** The titles of its parts, in order. */
  titles: string[];
  mode: HoldMode;
  /** Somebody is on the signing list for the role. */
  hasPerson: boolean;
}

/** What each role of the document holds: its parts, and whether it signs. Roles with nothing in the form still appear (a countersigner). */
export function roleHolds(form: FormDefinition, roles: readonly SignRole[], rows: readonly Pick<SignerRow, "roleKey">[], locale: SignLocale): RoleHolds[] {
  const lines = formPartLines(form, roles, locale);
  const used = new Set(rows.map((r) => r.roleKey));
  return roles.map((r) => {
    const mine = lines.filter((l) => l.roleKey === r.key);
    const signs = r.kind === "signer";
    const mode: HoldMode = mine.length > 0 ? (signs ? "partsSign" : "partsFill") : signs ? "signOnly" : "nothing";
    return {
      roleKey: r.key,
      roleLabel: r.label,
      color: r.color,
      kind: r.kind,
      partCount: mine.length,
      ranges: partRanges(mine.map((l) => l.number)),
      titles: mine.map((l) => l.title),
      mode,
      hasPerson: used.has(r.key),
    };
  });
}

// ---- the linked contact ---------------------------------------------------------------------

export interface ContactPrefill {
  /** Data fields that name a contact field. */
  mapped: DataField[];
  /** The distinct contact fields they name ("name", "email", "custom:Branch"), in order of first use. */
  contactFields: string[];
  /** The form will start with the contact's values: it maps contact fields and a contact is chosen. */
  willPrefill: boolean;
  /** The form maps contact fields but no contact is chosen, so nothing will be filled in. */
  warnNoContact: boolean;
}

export function contactPrefill(form: FormDefinition, contactId: string | null): ContactPrefill {
  const mapped = form.fields.filter((f) => !!f.contactField);
  const contactFields = [...new Set(mapped.map((f) => f.contactField as string))];
  const has = mapped.length > 0;
  return { mapped, contactFields, willPrefill: has && !!contactId, warnNoContact: has && !contactId };
}
