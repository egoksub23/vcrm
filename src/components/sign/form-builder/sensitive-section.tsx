"use client";

// The "Sensitive (encrypted and masked)" switch of a data field, and how the answer is printed on the sealed PDF.
// Turning it on removes what cannot go with it (a contact field to fill, a starting value, the lock): the form's own
// validation (forms/sensitive.ts) says the same, and refuses the pair on the server.

import { useTranslations } from "next-intl";

import { Switch } from "@/components/ui/switch";
import { omit } from "@/lib/sign/client/form-edit";
import { canBeSensitive } from "@/lib/sign/forms/sensitive";
import type { DataField } from "@/lib/sign/forms/types";

import { FormRow, NativeSelect, Section } from "./form-bits";

type Change = (change: Partial<DataField> | ((f: DataField) => DataField), coalesceKey?: string) => void;

/** What a sensitive field gives up. */
function turnOn(f: DataField): DataField {
  const next = omit(omit(omit(omit(f, "contactField"), "writeBack"), "defaultValue"), "locked") as DataField;
  return { ...next, sensitive: true };
}

function turnOff(f: DataField): DataField {
  return omit(omit(f, "sensitive"), "printMasked") as DataField;
}

export function SensitiveSection({ field, disabled, onChange }: { field: DataField; disabled?: boolean; onChange: Change }) {
  const t = useTranslations("Sign.formBuilder");
  if (!canBeSensitive(field.type)) return null;
  const on = field.sensitive === true;
  const labelId = `sensitive-label-${field.key}`;
  const printId = `sensitive-print-${field.key}`;
  return (
    <Section title={t("sensitive.title")}>
      <div className="flex items-start gap-2 text-sm">
        <Switch checked={on} disabled={disabled} aria-labelledby={labelId} aria-describedby={`sensitive-hint-${field.key}`} className="mt-0.5" onCheckedChange={(v) => onChange(v ? turnOn : turnOff)} />
        <div>
          <span id={labelId}>{t("sensitive.label")}</span>
          <span id={`sensitive-hint-${field.key}`} className="block text-[11px] text-muted-foreground">
            {t("sensitive.hint")}
          </span>
        </div>
      </div>
      {on ? (
        <FormRow label={t("sensitive.print")} htmlFor={printId} hint={t("sensitive.printHint")}>
          <NativeSelect
            id={printId}
            value={field.printMasked ?? "full"}
            disabled={disabled}
            onChange={(e) => onChange((f) => (e.target.value === "full" ? (omit(f, "printMasked") as DataField) : { ...f, printMasked: e.target.value as "last4" | "none" }))}
          >
            <option value="full">{t("sensitive.printFull")}</option>
            <option value="last4">{t("sensitive.printLast4")}</option>
            <option value="none">{t("sensitive.printNone")}</option>
          </NativeSelect>
        </FormRow>
      ) : null}
    </Section>
  );
}
