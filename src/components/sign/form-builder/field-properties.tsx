"use client";

// The right-hand side of the form builder for one data field: its texts in each language, key, the settings of
// its type, required and visibility rules, the contact field it fills, a starting value, and where it prints.

import { Copy, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cleanDataKey, DATA_KEY_RE } from "@/lib/sign/client/form-keys";
import { pick } from "@/lib/sign/forms/text";
import { DATA_FIELD_TYPES, type DataField, type DataFieldType, type FormDefinition, type L10n, type Rule } from "@/lib/sign/forms/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignLocale } from "@/lib/sign/types";

import { ContactSection, PrintedSection, ValueSection } from "./field-sections";
import { FormRow, L10nField, NativeSelect, Section } from "./form-bits";
import { DATA_TYPE_ICONS } from "./type-icons";
import { RuleEditor } from "./rule-editor";
import { TypeSettings } from "./type-settings";

const PLACEHOLDER_TYPES: readonly DataFieldType[] = ["text", "multiline", "email", "phone", "number", "list"];

export interface FieldPropertiesProps {
  field: DataField;
  form: FormDefinition;
  placements: readonly PlacedField[];
  lang: SignLocale;
  readOnly: boolean;
  /** The key cannot be changed: the template has been used. */
  keyLocked: boolean;
  /** The key still follows the English label. */
  followsLabel: boolean;
  lockedOptionValues: ReadonlySet<string>;
  customFields: readonly string[];
  onPatch: (key: string, change: Partial<DataField> | ((f: DataField) => DataField), coalesceKey?: string) => void;
  onSetKey: (key: string, next: string) => boolean;
  onChangeType: (key: string, type: DataFieldType) => void;
  onMoveToPart: (key: string, part: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenEditor: (focusKey?: string) => void;
}

export function FieldProperties(p: FieldPropertiesProps) {
  const { field, form, lang, readOnly } = p;
  const t = useTranslations("Sign.formBuilder");
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const Icon = DATA_TYPE_ICONS[field.type];
  const k = field.key;
  const change = (c: Partial<DataField> | ((f: DataField) => DataField), coalesce?: string) => p.onPatch(k, c, coalesce);
  const setL10n = (prop: "label" | "help" | "placeholder" | "text") => (next: L10n | undefined, coalesceKey: string) =>
    change((f) => {
      const copy: DataField = { ...f };
      if (next === undefined) delete copy[prop];
      else Object.assign(copy, { [prop]: next });
      return copy;
    }, coalesceKey);
  const setRule = (prop: "visibleIf" | "requiredIf") => (next: Rule | undefined, coalesceKey: string) =>
    change((f) => {
      const copy: DataField = { ...f };
      if (next === undefined) delete copy[prop];
      else copy[prop] = next;
      return copy;
    }, coalesceKey);

  const shownKey = keyDraft ?? k;
  const keyTaken = (candidate: string) => form.fields.some((f) => f.key !== k && f.key === candidate) || p.placements.some((x) => x.key === candidate);
  const keyProblem = !DATA_KEY_RE.test(shownKey) ? t("key.bad") : keyTaken(shownKey) ? t("key.taken") : null;
  const acknowledge = field.type === "acknowledge";

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{pick(field.label, lang) || t("props.unnamed")}</h3>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FormRow label={t("props.type")} htmlFor={`type-${k}`}>
          <NativeSelect id={`type-${k}`} value={field.type} disabled={readOnly} onChange={(e) => p.onChangeType(k, e.target.value as DataFieldType)}>
            {DATA_FIELD_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`types.${ty}`)}
              </option>
            ))}
          </NativeSelect>
        </FormRow>
        <FormRow label={t("props.part")} htmlFor={`part-${k}`}>
          <NativeSelect id={`part-${k}`} value={field.part} disabled={readOnly} onChange={(e) => p.onMoveToPart(k, e.target.value)}>
            {form.parts.map((part) => (
              <option key={part.key} value={part.key}>
                {pick(part.title, lang) || part.key}
              </option>
            ))}
            {!form.parts.some((x) => x.key === field.part) ? <option value={field.part}>{field.part}</option> : null}
          </NativeSelect>
        </FormRow>
      </div>

      <Section title={t("texts.title")} hint={lang === "en" ? undefined : t("texts.hintOther")}>
        <L10nField label={t("texts.label")} value={field.label} lang={lang} required maxLength={200} disabled={readOnly} focusId="field-label" coalesceKey="label" onChange={setL10n("label")} />
        {acknowledge ? (
          <L10nField label={t("texts.acknowledge")} value={field.text} lang={lang} required multiline rows={5} maxLength={8000} disabled={readOnly} hint={t("texts.acknowledgeHint")} coalesceKey="text" onChange={setL10n("text")} />
        ) : null}
        <L10nField label={t("texts.help")} value={field.help} lang={lang} multiline rows={2} maxLength={600} disabled={readOnly} hint={t("texts.helpHint")} coalesceKey="help" onChange={setL10n("help")} />
        {PLACEHOLDER_TYPES.includes(field.type) ? <L10nField label={t("texts.placeholder")} value={field.placeholder} lang={lang} maxLength={120} disabled={readOnly} coalesceKey="placeholder" onChange={setL10n("placeholder")} /> : null}
      </Section>

      <Section title={t("key.title")}>
        <FormRow label={t("key.label")} htmlFor={`key-${k}`} hint={p.keyLocked ? t("key.locked") : p.followsLabel ? t("key.follows") : t("key.hint")}>
          <Input
            id={`key-${k}`}
            value={shownKey}
            disabled={readOnly || p.keyLocked}
            maxLength={40}
            className="font-mono text-xs"
            aria-invalid={!!keyProblem || undefined}
            onChange={(e) => {
              const raw = e.target.value;
              setKeyDraft(raw);
              const clean = cleanDataKey(raw);
              if (clean && clean !== k && !keyTaken(clean)) p.onSetKey(k, clean);
            }}
            onBlur={() => setKeyDraft(null)}
          />
        </FormRow>
        {keyProblem ? <p className="text-[11px] text-destructive">{keyProblem}</p> : null}
      </Section>

      <Section title={t("type.title", { type: t(`types.${field.type}`) })}>
        <TypeSettings key={k} field={field} lang={lang} disabled={readOnly} lockedOptionValues={p.lockedOptionValues} onChange={change} />
      </Section>

      <Section title={t("required.title")}>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={acknowledge || field.required} disabled={readOnly || acknowledge} onCheckedChange={(v) => change({ required: v === true })} />
          <span>
            {t("required.label")}
            {acknowledge ? <span className="block text-[11px] text-muted-foreground">{t("required.acknowledge")}</span> : null}
          </span>
        </label>
        {!field.required && !acknowledge ? (
          <RuleEditor title={t("required.ifTitle")} sentence="requiredWhen" rule={field.requiredIf} form={form} ownerKey={k} lang={lang} disabled={readOnly} coalesceKey="requiredIf" onChange={setRule("requiredIf")} />
        ) : null}
      </Section>

      <Section title={t("visible.title")}>
        <RuleEditor title={t("visible.ifTitle")} sentence="showWhen" rule={field.visibleIf} form={form} ownerKey={k} lang={lang} disabled={readOnly} coalesceKey="visibleIf" onChange={setRule("visibleIf")} />
        {!field.visibleIf ? <p className="text-[11px] text-muted-foreground">{t("visible.always")}</p> : null}
      </Section>

      <ContactSection field={field} customFields={p.customFields} disabled={readOnly} onChange={change} />
      <ValueSection field={field} lang={lang} disabled={readOnly} onChange={change} />
      <PrintedSection field={field} placements={p.placements} onOpenEditor={p.onOpenEditor} />

      {readOnly ? null : (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <Button type="button" variant="outline" size="sm" onClick={p.onDuplicate}>
            <Copy />
            {t("props.duplicate")}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={p.onDelete}>
            <Trash2 />
            {t("props.delete")}
          </Button>
        </div>
      )}
    </div>
  );
}
