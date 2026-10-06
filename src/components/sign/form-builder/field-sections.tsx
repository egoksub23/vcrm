"use client";

// Sections of a data field's properties that are not about its type: the contact field it fills, a starting value,
// the lock, and where it is printed on the form.

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { contactChoices } from "@/lib/sign/client/form-contact";
import { contactCapable, omit } from "@/lib/sign/client/form-edit";
import { printedOn } from "@/lib/sign/client/form-printing";
import { pick } from "@/lib/sign/forms/text";
import type { DataField } from "@/lib/sign/forms/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignLocale } from "@/lib/sign/types";

import { FormRow, NativeSelect, Section } from "./form-bits";

type Change = (change: Partial<DataField> | ((f: DataField) => DataField), coalesceKey?: string) => void;

/** Which contact field this answer fills, and whether it overwrites. */
export function ContactSection({ field, customFields, disabled, onChange }: { field: DataField; customFields: readonly string[]; disabled?: boolean; onChange: Change }) {
  const t = useTranslations("Sign.formBuilder");
  if (!contactCapable(field.type)) return null;
  const choices = contactChoices(customFields, field.contactField);
  const builtIn = choices.filter((c) => c.kind === "base");
  const custom = choices.filter((c) => c.kind === "custom");
  const unknown = choices.filter((c) => c.kind === "unknown");
  const id = `contact-${field.key}`;
  return (
    <Section title={t("contact.title")} hint={t("contact.hint")}>
      <FormRow label={t("contact.field")} htmlFor={id}>
        <NativeSelect
          id={id}
          value={field.contactField ?? ""}
          disabled={disabled}
          onChange={(e) => onChange((f) => (e.target.value === "" ? (omit(omit(f, "contactField"), "writeBack") as DataField) : { ...f, contactField: e.target.value }))}
        >
          <option value="">{t("contact.none")}</option>
          <optgroup label={t("contact.builtIn")}>
            {builtIn.map((c) => (
              <option key={c.value} value={c.value}>
                {t(`contact.base.${c.name}`)}
              </option>
            ))}
          </optgroup>
          {custom.length > 0 ? (
            <optgroup label={t("contact.custom")}>
              {custom.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {unknown.map((c) => (
            <option key={c.value} value={c.value}>
              {t("contact.unknown", { name: c.name })}
            </option>
          ))}
        </NativeSelect>
      </FormRow>
      {field.contactField ? (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-muted-foreground">{t("contact.writeBack")}</legend>
          {(["always", "if_empty"] as const).map((mode) => (
            <label key={mode} className="flex items-start gap-2 text-sm">
              <input type="radio" name={`wb-${field.key}`} className="mt-1" checked={(field.writeBack ?? "always") === mode} disabled={disabled} onChange={() => onChange({ writeBack: mode })} />
              <span>
                {t(`contact.mode.${mode}`)}
                <span className="block text-[11px] text-muted-foreground">{t(`contact.modeHint.${mode}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {customFields.length === 0 ? <p className="text-[11px] text-muted-foreground">{t("contact.noCustom")}</p> : null}
    </Section>
  );
}

const DEFAULT_TYPES: readonly DataField["type"][] = ["text", "multiline", "email", "phone", "number", "date", "choice"];

/** A starting value and the lock. */
export function ValueSection({ field, lang, disabled, onChange }: { field: DataField; lang: SignLocale; disabled?: boolean; onChange: Change }) {
  const t = useTranslations("Sign.formBuilder");
  const hasDefault = DEFAULT_TYPES.includes(field.type);
  const setDefault = (v: string) => onChange((f) => (v === "" ? (omit(f, "defaultValue") as DataField) : { ...f, defaultValue: v }), `default:${field.key}`);
  if (!hasDefault && field.type === "file") return null;
  return (
    <Section title={t("value.title")}>
      {hasDefault ? (
        <FormRow label={t("value.default")} htmlFor={`def-${field.key}`} hint={t("value.defaultHint")}>
          {field.type === "choice" ? (
            <NativeSelect id={`def-${field.key}`} value={field.defaultValue ?? ""} disabled={disabled} onChange={(e) => setDefault(e.target.value)}>
              <option value="">{t("value.noDefault")}</option>
              {(field.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {pick(o.label, lang) || o.value}
                </option>
              ))}
              {field.defaultValue && !(field.options ?? []).some((o) => o.value === field.defaultValue) ? <option value={field.defaultValue}>{t("value.staleDefault", { value: field.defaultValue })}</option> : null}
            </NativeSelect>
          ) : (
            <Input id={`def-${field.key}`} type={field.type === "date" ? "date" : "text"} value={field.defaultValue ?? ""} disabled={disabled} maxLength={200} onChange={(e) => setDefault(e.target.value)} />
          )}
        </FormRow>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <Checkbox className="mt-0.5" checked={!!field.locked} disabled={disabled} onCheckedChange={(v) => onChange((f) => (v === true ? { ...f, locked: true } : (omit(f, "locked") as DataField)))} />
        <span>
          {t("value.locked")}
          <span className="block text-[11px] text-muted-foreground">{t("value.lockedHint")}</span>
        </span>
      </label>
    </Section>
  );
}

/** "Printed on the form: Page 2, 1 place", with a way to open the template editor at it. */
export function PrintedSection({ field, placements, onOpenEditor }: { field: DataField; placements: readonly PlacedField[]; onOpenEditor: (focusKey?: string) => void }) {
  const t = useTranslations("Sign.formBuilder");
  const printed = printedOn(placements, field.key);
  const printable = field.type !== "file";
  return (
    <Section title={t("printed.title")}>
      {!printable ? (
        <p className="text-sm text-muted-foreground">{t("printed.file")}</p>
      ) : printed.places === 0 ? (
        <p className="text-sm text-muted-foreground">{t("printed.none")}</p>
      ) : (
        <p className="text-sm">{t("printed.summary", { pages: new Intl.ListFormat(undefined, { type: "conjunction" }).format(printed.pages.map(String)), pageCount: printed.pages.length, count: printed.places })}</p>
      )}
      {printed.places > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("printed.places")}>
          {printed.placements.map((p) => (
            <li key={p.key}>
              <Button type="button" variant="outline" size="xs" onClick={() => onOpenEditor(p.key)}>
                {t("printed.openPlace", { page: p.page + 1 })}
                <ExternalLink />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {printable ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenEditor(printed.placements[0]?.key)}>
            <ExternalLink />
            {printed.places > 0 ? t("printed.open") : t("printed.openToPlace")}
          </Button>
          {printed.places === 0 ? <p className="mt-1 text-[11px] text-muted-foreground">{t("printed.placeHint")}</p> : null}
        </div>
      ) : null}
    </Section>
  );
}
