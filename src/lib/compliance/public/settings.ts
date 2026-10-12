// ============================================================
// Compliance requests, Settings > Compliance > Public forms (compliance.manage). Server only.
//
// For each public type (the account closure form and the fund withdrawal form; a phone change is never public) the administrator chooses: whether the form is
// on, its address (/c/<slug>, random and unguessable; "regenerate" retires the old one at once), an extra notice shown above the form in each language,
// whether Turnstile is asked (only if the operator has set both keys), the largest amount a withdrawal accepts, and the list of banks. A form works only
// while the workspace's `compliance` flag is on AND the form is on; the flag is the operator's, not this screen's.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { turnstileEnabled } from "@/lib/sign/registration/turnstile";
import { makeSlug, regenerateSlug } from "@/lib/sign/registration/slug";

import { ComplianceError, complianceError } from "../errors";
import { loadType } from "../service/read";
import type { ComplianceCaller } from "../service/rows";
import { LOCALES } from "../types";
import { parseBankList } from "./banks";
import { FORM_COLUMNS, cleanNotice, typeSupportsPublicForm, type PublicFormRow } from "./service";
import type { PublicFormPatch, PublicFormSettings, PublicFormsAnswer } from "./settings-types";
import { PUBLIC_TYPES, type PublicType } from "./validate";

export type { PublicFormPatch, PublicFormSettings, PublicFormsAnswer } from "./settings-types";

const DEFAULT_MAX = 10_000;
export const NOTICE_MAX = 2000;

export async function listPublicForms(admin: SupabaseClient, caller: ComplianceCaller): Promise<PublicFormsAnswer> {
  if (!caller.viewer.canManage) throw complianceError("forbidden");
  const { data, error } = await admin.from("compliance_public_forms").select(FORM_COLUMNS).eq("account_id", caller.accountId);
  if (error) throw complianceError("server_error");
  const rows = new Map(((data ?? []) as unknown as PublicFormRow[]).map((r) => [r.type_key, r]));
  const forms: PublicFormSettings[] = [];
  for (const typeKey of PUBLIC_TYPES) {
    const r = rows.get(typeKey);
    const type = await loadType(admin, caller.accountId, typeKey);
    forms.push({
      typeKey,
      exists: !!r,
      enabled: r?.enabled === true,
      slug: r?.slug ?? null,
      notice: cleanNotice(r?.notice),
      turnstile: r?.turnstile === true,
      maxAmount: r ? Number(r.max_amount) : DEFAULT_MAX,
      banks: r?.banks && r.banks.length > 0 ? r.banks : null,
      ready: typeSupportsPublicForm(type, typeKey),
    });
  }
  return { forms, turnstileAvailable: turnstileEnabled() };
}

const isUnique = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "23505" || /duplicate key|unique constraint/i.test(e.message ?? ""));

export async function savePublicForm(admin: SupabaseClient, caller: ComplianceCaller, typeKey: string, patch: PublicFormPatch, now: () => Date = () => new Date()): Promise<PublicFormsAnswer> {
  if (!caller.viewer.canManage) throw complianceError("forbidden");
  if (!(PUBLIC_TYPES as readonly string[]).includes(typeKey)) throw complianceError("invalid_request");
  const kind = typeKey as PublicType;
  const type = await loadType(admin, caller.accountId, kind);
  const { data: existing, error } = await admin.from("compliance_public_forms").select(FORM_COLUMNS).eq("account_id", caller.accountId).eq("type_key", kind).maybeSingle();
  if (error) throw complianceError("server_error");
  const row = existing as unknown as PublicFormRow | null;

  const next: Record<string, unknown> = { updated_at: now().toISOString() };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw complianceError("invalid_request");
    // a form can be switched off whatever the type says; it can be switched on only when the type can take it
    if (patch.enabled && !typeSupportsPublicForm(type, kind)) throw complianceError("type_unavailable");
    next.enabled = patch.enabled;
  }
  if (patch.notice !== undefined) {
    const notice: Record<string, string> = {};
    for (const l of LOCALES) {
      const v = patch.notice?.[l];
      if (typeof v !== "string" || v.trim() === "") continue;
      const clean = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
      if (clean.length > NOTICE_MAX) throw new ComplianceError("validation_failed", "That notice is too long.", 400, [{ field: `notice_${l}`, code: "too_long" }]);
      notice[l] = clean;
    }
    next.notice = notice;
  }
  if (patch.turnstile !== undefined) {
    if (typeof patch.turnstile !== "boolean") throw complianceError("invalid_request");
    next.turnstile = patch.turnstile;
  }
  if (patch.maxAmount !== undefined) {
    const n = Number(patch.maxAmount);
    if (!Number.isFinite(n) || n <= 0 || n > 100_000_000 || Math.round(n * 100) / 100 !== n) throw new ComplianceError("validation_failed", "Enter an amount above zero with at most two decimals.", 400, [{ field: "max_amount", code: "invalid" }]);
    next.max_amount = n;
  }
  if (patch.banks !== undefined) {
    const list = patch.banks === null ? null : Array.isArray(patch.banks) ? parseBankList(patch.banks.filter((b) => typeof b === "string").join("\n")) : typeof patch.banks === "string" ? parseBankList(patch.banks) : null;
    next.banks = list;
  }

  if (!row) {
    // the first save makes the form, with an address nobody can guess
    for (let attempt = 0; attempt < 5; attempt++) {
      const ins = await admin
        .from("compliance_public_forms")
        .insert({ account_id: caller.accountId, type_key: kind, enabled: false, slug: makeSlug(kind === "closure" ? "account closure" : "fund withdrawal"), notice: {}, turnstile: false, max_amount: DEFAULT_MAX, ...next })
        .select("id")
        .single();
      if (!ins.error) break;
      if (!isUnique(ins.error) || attempt === 4) throw complianceError("server_error");
    }
  } else {
    if (patch.regenerateSlug === true) next.slug = regenerateSlug(row.slug);
    if (Object.keys(next).length > 1) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const upd = await admin.from("compliance_public_forms").update(next).eq("id", row.id).eq("account_id", caller.accountId);
        if (!upd.error) break;
        // a new address that already exists: draw another
        if (!isUnique(upd.error) || patch.regenerateSlug !== true || attempt === 4) throw complianceError("server_error");
        next.slug = regenerateSlug(row.slug);
      }
    }
  }
  return listPublicForms(admin, caller);
}
