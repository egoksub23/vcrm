"use client";

// One part's own settings: its title and description in each language, the role that completes it, and the rule
// that shows it.

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { pick } from "@/lib/sign/forms/text";
import type { FormDefinition, FormPart, L10n, Rule } from "@/lib/sign/forms/types";
import type { SignLocale, SignRole } from "@/lib/sign/types";

import { FormRow, L10nField, NativeSelect } from "./form-bits";
import { RuleEditor } from "./rule-editor";

interface PartSettingsProps {
  part: FormPart;
  form: FormDefinition;
  roles: readonly SignRole[];
  lang: SignLocale;
  readOnly: boolean;
  onPatch: (key: string, patch: Partial<Omit<FormPart, "key">> | ((p: FormPart) => FormPart), coalesceKey?: string) => void;
  onDelete: () => void;
}

export function PartSettings({ part, form, roles, lang, readOnly, onPatch, onDelete }: PartSettingsProps) {
  const t = useTranslations("Sign.formBuilder");
  const k = part.key;
  const setL10n = (prop: "title" | "description") => (next: L10n | undefined, coalesceKey: string) =>
    onPatch(
      k,
      (p) => {
        const copy: FormPart = { ...p };
        if (next === undefined) delete copy[prop];
        else Object.assign(copy, { [prop]: next });
        return copy;
      },
      coalesceKey,
    );
  const setRule = (next: Rule | undefined, coalesceKey: string) =>
    onPatch(
      k,
      (p) => {
        const copy: FormPart = { ...p };
        if (next === undefined) delete copy.visibleIf;
        else copy.visibleIf = next;
        return copy;
      },
      coalesceKey,
    );
  const role = roles.find((r) => r.key === part.role);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <L10nField label={t("partSettings.title")} value={part.title} lang={lang} required maxLength={120} disabled={readOnly} focusId="part-title" coalesceKey="partTitle" onChange={setL10n("title")} />
      <L10nField label={t("partSettings.description")} value={part.description} lang={lang} multiline rows={2} maxLength={600} disabled={readOnly} hint={t("partSettings.descriptionHint")} coalesceKey="partDescription" onChange={setL10n("description")} />
      <FormRow label={t("partSettings.role")} htmlFor={`part-role-${k}`} hint={role ? (role.kind === "filler" ? t("partSettings.roleFiller") : t("partSettings.roleSigner")) : t("partSettings.roleMissing")}>
        <NativeSelect id={`part-role-${k}`} value={part.role} disabled={readOnly} aria-invalid={!role || undefined} onChange={(e) => onPatch(k, { role: e.target.value })}>
          {!role ? <option value={part.role}>{t("parts.noRole")}</option> : null}
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label} ({r.kind === "filler" ? t("partSettings.kindFiller") : t("partSettings.kindSigner")})
            </option>
          ))}
        </NativeSelect>
      </FormRow>
      <RuleEditor title={t("partSettings.ifTitle")} sentence="partShowWhen" rule={part.visibleIf} form={form} lang={lang} disabled={readOnly} coalesceKey="partVisibleIf" onChange={setRule} />
      {readOnly ? null : (
        <div className="border-t pt-2">
          <Button type="button" variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 />
            {t("partSettings.delete", { name: pick(part.title, lang) || t("parts.unnamed") })}
          </Button>
        </div>
      )}
    </div>
  );
}
