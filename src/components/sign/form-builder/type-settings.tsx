"use client";

// The settings that belong to one type of data field: what a text may look like, the range of a number, how many
// entries a list holds, which files and how big, the options of a choice. Every control writes a property of the
// DataField and removes it when emptied, so a stored form carries only what was set.

import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { omit } from "@/lib/sign/client/form-edit";
import { FILE_KINDS, MAX_FILES_PER_FIELD, MAX_UPLOAD_MB, TEXT_FORMATS, type DataField, type FileKind, type TextFormat } from "@/lib/sign/forms/types";
import type { SignLocale } from "@/lib/sign/types";

import { FormRow, NativeSelect, NumberField } from "./form-bits";
import { ListSource } from "./list-source";
import { OptionsEditor } from "./options-editor";

interface TypeSettingsProps {
  field: DataField;
  lang: SignLocale;
  disabled?: boolean;
  lockedOptionValues: ReadonlySet<string>;
  onChange: (change: Partial<DataField> | ((f: DataField) => DataField), coalesceKey?: string) => void;
}

export function TypeSettings({ field, lang, disabled, lockedOptionValues, onChange }: TypeSettingsProps) {
  const t = useTranslations("Sign.formBuilder");
  const k = field.key;
  /** Set one optional property, or remove it. */
  const set = <K extends keyof DataField>(key: K, value: DataField[K] | undefined, coalesce?: string) =>
    onChange((f) => (value === undefined ? (omit(f, key) as DataField) : { ...f, [key]: value }), coalesce ? `${coalesce}:${k}` : undefined);

  const formatSelect = (id: string, label: string, value: TextFormat | undefined, onPick: (v: TextFormat | undefined) => void) => (
    <FormRow label={label} htmlFor={id}>
      <NativeSelect id={id} value={value ?? "any"} disabled={disabled} onChange={(e) => onPick(e.target.value === "any" ? undefined : (e.target.value as TextFormat))}>
        {TEXT_FORMATS.map((f) => (
          <option key={f} value={f}>
            {t(`type.formats.${f}`)}
          </option>
        ))}
      </NativeSelect>
    </FormRow>
  );

  switch (field.type) {
    case "text":
    case "multiline":
      return (
        <div className="space-y-2">
          {formatSelect(`fmt-${k}`, t("type.format"), field.format, (v) => set("format", v))}
          <div className="grid grid-cols-2 gap-2">
            <NumberField label={t("type.minLength")} value={field.minLength} integer min={0} max={5000} disabled={disabled} onChange={(v) => set("minLength", v, "minLength")} />
            <NumberField label={t("type.maxLength")} value={field.maxLength} integer min={0} max={5000} disabled={disabled} placeholder={field.type === "multiline" ? "2000" : "200"} onChange={(v) => set("maxLength", v, "maxLength")} />
          </div>
        </div>
      );
    case "number":
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <NumberField label={t("type.min")} value={field.min} disabled={disabled} onChange={(v) => set("min", v, "min")} />
            <NumberField label={t("type.max")} value={field.max} disabled={disabled} onChange={(v) => set("max", v, "max")} />
          </div>
          <FormRow label={t("type.decimals")} htmlFor={`dec-${k}`}>
            <NativeSelect id={`dec-${k}`} value={field.decimals === undefined ? "" : String(field.decimals)} disabled={disabled} onChange={(e) => set("decimals", e.target.value === "" ? undefined : Number(e.target.value))}>
              <option value="">{t("type.decimalsAny")}</option>
              {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </FormRow>
        </div>
      );
    case "email":
      return <p className="text-xs text-muted-foreground">{t("type.emailHint")}</p>;
    case "phone":
      return <p className="text-xs text-muted-foreground">{t("type.phoneHint")}</p>;
    case "date":
      return <p className="text-xs text-muted-foreground">{t("type.dateHint")}</p>;
    case "yesno":
      return <p className="text-xs text-muted-foreground">{t("type.yesnoHint")}</p>;
    case "image":
      return <p className="text-xs text-muted-foreground">{t("type.imageHint")}</p>;
    case "acknowledge":
      return <p className="text-xs text-muted-foreground">{t("type.acknowledgeHint")}</p>;
    case "choice":
    case "multichoice":
      return (
        <div className="space-y-3">
          <ListSource field={field} lang={lang} disabled={disabled} onChange={onChange} />
          {field.optionList === undefined ? <OptionsEditor options={field.options ?? []} lang={lang} disabled={disabled} lockedValues={lockedOptionValues} coalesceKey={`options:${k}`} onChange={(options, key) => onChange({ options }, key)} /> : null}
        </div>
      );
    case "list":
      return (
        <div className="space-y-2">
          <ListSource field={field} lang={lang} disabled={disabled} onChange={onChange} />
          <div className="grid grid-cols-2 gap-2">
            <NumberField label={t("type.minItems")} value={field.minItems} integer min={0} max={5000} disabled={disabled} onChange={(v) => set("minItems", v, "minItems")} />
            <NumberField label={t("type.maxItems")} value={field.maxItems} integer min={0} max={5000} disabled={disabled} placeholder="20" onChange={(v) => set("maxItems", v, "maxItems")} />
          </div>
          {field.optionList === undefined ? (
            <>
              {formatSelect(`ifmt-${k}`, t("type.itemFormat"), field.itemFormat, (v) => set("itemFormat", v))}
              <NumberField label={t("type.itemLength")} value={field.itemLength} integer min={0} max={5000} disabled={disabled} placeholder="100" hint={t("type.itemLengthHint")} onChange={(v) => set("itemLength", v, "itemLength")} />
            </>
          ) : null}
        </div>
      );
    case "file": {
      const accept = field.accept ?? [];
      const toggle = (kind: FileKind, on: boolean) => set("accept", FILE_KINDS.filter((x) => (x === kind ? on : accept.includes(x))) as FileKind[]);
      const maxFiles = field.maxFiles ?? 1;
      return (
        <div className="space-y-2">
          <fieldset className="space-y-1" aria-invalid={accept.length === 0 || undefined}>
            <legend className="text-xs font-medium text-muted-foreground">{t("type.accept")}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {FILE_KINDS.map((kind) => (
                <label key={kind} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={accept.includes(kind)} disabled={disabled} onCheckedChange={(v) => toggle(kind, v === true)} />
                  {t(`type.kinds.${kind}`)}
                </label>
              ))}
            </div>
            {accept.length === 0 ? <p className="text-[11px] text-destructive">{t("type.acceptNone")}</p> : <p className="text-[11px] text-muted-foreground">{t("type.acceptHint")}</p>}
          </fieldset>
          <div className="grid grid-cols-3 gap-2">
            <NumberField label={t("type.maxMb")} value={field.maxMb} min={0.1} max={MAX_UPLOAD_MB} placeholder="5" disabled={disabled} onChange={(v) => set("maxMb", v, "maxMb")} />
            <NumberField label={t("type.maxFiles")} value={field.maxFiles} integer min={1} max={MAX_FILES_PER_FIELD} placeholder="1" disabled={disabled} onChange={(v) => set("maxFiles", v, "maxFiles")} />
            <NumberField label={t("type.minFiles")} value={field.minFiles} integer min={0} max={maxFiles} placeholder="0" disabled={disabled} onChange={(v) => set("minFiles", v, "minFiles")} />
          </div>
          <p className="text-[11px] text-muted-foreground">{t("type.fileLimits", { mb: MAX_UPLOAD_MB })}</p>
        </div>
      );
    }
    default:
      return null;
  }
}
