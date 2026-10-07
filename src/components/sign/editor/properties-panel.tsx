"use client";

import { Copy, CopyPlus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ANSWERED_TYPES, SENDER_ROLE } from "@/lib/sign/rules";
import { DATE_FORMAT_PRESETS, applyMerge, canMerge, isValidDateFormat, roleKindAllows, sanitizeKey, suggestMergeKey } from "@/lib/sign/client/layout";
import { bindPlacement, bindableFields, takesOptionValue, unbindPlacement } from "@/lib/sign/client/form-printing";
import { pick } from "@/lib/sign/forms/text";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { FieldType, PlacedField } from "@/lib/sign/pdf/types";
import type { SignLocale, SignRole } from "@/lib/sign/types";

import { FIELD_ICONS } from "./field-icons";
import { FormRow, NativeSelect } from "./form-bits";
import { useRoleEmails } from "./role-emails";
import { cn } from "@/lib/utils";

export type FieldChange = Partial<PlacedField> | ((f: PlacedField) => PlacedField);

function setProp<K extends keyof PlacedField>(f: PlacedField, key: K, value: PlacedField[K] | undefined): PlacedField {
  if (value === undefined) {
    const { [key]: dropped, ...rest } = f;
    void dropped;
    return rest as PlacedField;
  }
  return { ...f, [key]: value };
}

const FONT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32];
const TEXT_TYPES: readonly FieldType[] = ["text", "number", "date", "date_signed", "name", "static_text", "dropdown", "initials"];

interface PropertiesPanelProps {
  field: PlacedField | null;
  fields: readonly PlacedField[];
  roles: readonly SignRole[];
  readOnly: boolean;
  typeLabels: Record<FieldType, string>;
  mergeKeys: readonly string[];
  pageCount: number;
  senderLabel: string;
  /** Forms: the template's form; when there is one, a placement can be made to print one of its data fields. */
  form?: FormDefinition | null;
  /** The language the data field labels are shown in. */
  labelLocale?: SignLocale;
  onChange: (change: FieldChange, coalesceKey?: string) => void;
  onDuplicate: () => void;
  onCopyToPages: () => void;
  onDelete: () => void;
}

export function PropertiesPanel({ field, fields, roles, readOnly, typeLabels, mergeKeys, pageCount, senderLabel, form, labelLocale = "en", onChange, onDuplicate, onCopyToPages, onDelete }: PropertiesPanelProps) {
  const t = useTranslations("Sign.editor");
  const tf = useTranslations("Sign.formBuilder");
  const emails = useRoleEmails();
  if (!field) return <p className="p-3 text-sm text-muted-foreground">{t("props.none")}</p>;

  const Icon = FIELD_ICONS[field.type];
  const id = (name: string) => `prop-${name}-${field.key}`;
  const bound = !!field.data;
  const senderFixed = field.type === "static_text" || !!field.merge || bound;
  const answered = ANSWERED_TYPES.includes(field.type) && !field.merge && !bound;
  const mergeable = canMerge(field.type);
  const patch = (p: Partial<PlacedField>, coalesce?: string) => onChange(p, coalesce);
  const set = <K extends keyof PlacedField>(key: K, value: PlacedField[K] | undefined, coalesce?: string) => onChange((f) => setProp(f, key, value), coalesce);
  const allowedRoles = roles.filter((r) => roleKindAllows(r.kind, field.type));

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">{typeLabels[field.type]}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{t("props.onPage", { page: field.page + 1 })}</span>
      </div>

      <FormRow label={t("props.role")} htmlFor={id("role")} hint={senderFixed ? t("props.roleSender") : undefined}>
        {senderFixed ? (
          <Input id={id("role")} value={senderLabel} disabled readOnly />
        ) : allowedRoles.some((r) => emails[r.key]) ? (
          <div id={id("role")} role="radiogroup" aria-label={t("props.role")} className="space-y-1">
            {allowedRoles.map((r) => {
              const on = r.key === field.role;
              return (
                <button
                  key={r.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={readOnly}
                  data-role-option={r.key}
                  onClick={() => patch({ role: r.key })}
                  className={cn("flex w-full min-w-0 flex-col rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60", on ? "border-primary bg-primary/10" : "border-input bg-background hover:bg-muted/60")}
                >
                  <span className="truncate text-sm font-medium">{r.label}</span>
                  {emails[r.key] ? <span className="truncate text-xs text-muted-foreground">{emails[r.key]}</span> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <NativeSelect id={id("role")} value={field.role} disabled={readOnly} onChange={(e) => patch({ role: e.target.value })}>
            {!allowedRoles.some((r) => r.key === field.role) ? <option value={field.role}>{field.role}</option> : null}
            {allowedRoles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormRow>

      {form && (bound || bindableFields(form, field).length > 0) ? (
        <FillWithAnswer
          field={field}
          form={form}
          roles={roles}
          disabled={readOnly}
          locale={labelLocale}
          onChange={onChange}
          label={tf("editor.fillWith")}
          noneLabel={tf("editor.fillNone")}
          optionLabel={tf("editor.fillOption")}
          hint={bound ? tf("editor.boundNote") : tf("editor.fillHint")}
          missing={(key) => tf("editor.fillMissing", { key })}
        />
      ) : null}

      {field.type === "static_text" && !field.merge ? (
        <FormRow label={t("props.staticText")} htmlFor={id("text")}>
          <Textarea id={id("text")} rows={3} value={field.text ?? ""} disabled={readOnly} maxLength={2000} onChange={(e) => set("text", e.target.value, `text:${field.key}`)} aria-invalid={!field.text} />
        </FormRow>
      ) : bound ? null : (
        <FormRow label={t("props.label")} htmlFor={id("label")} hint={answered ? t("props.labelHint") : undefined}>
          <Input id={id("label")} value={field.label ?? ""} disabled={readOnly} maxLength={100} onChange={(e) => set("label", e.target.value || undefined, `label:${field.key}`)} />
        </FormRow>
      )}

      {answered ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={field.required} disabled={readOnly} onCheckedChange={(v) => patch({ required: v === true })} />
          {t("props.required")}
        </label>
      ) : null}

      {field.type === "dropdown" && !bound ? <OptionsEditor key={field.key} id={id("options")} options={field.options ?? []} disabled={readOnly} onChange={(o) => set("options", o, `options:${field.key}`)} /> : null}

      {field.type === "date" || field.type === "date_signed" ? <DateFormatControl key={field.key} id={id("dateformat")} value={field.dateFormat} disabled={readOnly} onChange={(v) => set("dateFormat", v)} /> : null}

      {field.type === "number" ? (
        <FormRow label={t("props.decimals")} htmlFor={id("decimals")}>
          <NativeSelect id={id("decimals")} value={field.decimals === undefined ? "" : String(field.decimals)} disabled={readOnly} onChange={(e) => set("decimals", e.target.value === "" ? undefined : Number(e.target.value))}>
            <option value="">{t("props.decimalsAny")}</option>
            {[0, 1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </FormRow>
      ) : null}

      {field.type === "text" && !field.merge ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={!!field.multiline} disabled={readOnly} onCheckedChange={(v) => set("multiline", v === true ? true : undefined)} />
          {t("props.multiline")}
        </label>
      ) : null}

      {TEXT_TYPES.includes(field.type) ? (
        <div className="grid grid-cols-2 gap-2">
          <FormRow label={t("props.fontSize")} htmlFor={id("font")}>
            <NativeSelect id={id("font")} value={field.fontSize === undefined ? "" : String(field.fontSize)} disabled={readOnly} onChange={(e) => set("fontSize", e.target.value === "" ? undefined : Number(e.target.value))}>
              <option value="">{t("props.fontAuto")}</option>
              {FONT_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              {field.fontSize !== undefined && !FONT_SIZES.includes(field.fontSize) ? <option value={field.fontSize}>{field.fontSize}</option> : null}
            </NativeSelect>
          </FormRow>
          <FormRow label={t("props.align")} htmlFor={id("align")}>
            <NativeSelect id={id("align")} value={field.align ?? "left"} disabled={readOnly} onChange={(e) => set("align", e.target.value === "left" ? undefined : (e.target.value as "center" | "right"))}>
              <option value="left">{t("props.alignLeft")}</option>
              <option value="center">{t("props.alignCenter")}</option>
              <option value="right">{t("props.alignRight")}</option>
            </NativeSelect>
          </FormRow>
        </div>
      ) : null}

      {mergeable && !bound ? (
        <MergeControl
          key={field.key}
          field={field}
          mergeKeys={mergeKeys}
          inputId={id("merge")}
          disabled={readOnly}
          onToggle={(on) =>
            onChange((f) => applyMerge(f, on ? suggestMergeKey(fields) : undefined, roles, roles[0]?.key))
          }
          onKey={(key) => patch({ merge: key }, `merge:${field.key}`)}
        />
      ) : null}

      {readOnly ? null : (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <Button type="button" variant="outline" size="sm" onClick={onDuplicate}>
            <Copy />
            {t("props.duplicate")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={pageCount < 2} onClick={onCopyToPages}>
            <CopyPlus />
            {t("props.copyToPages")}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 />
            {t("props.delete")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Forms: "Fill with answer": which data field of the form this box prints, and for a tick box which option it ticks for. */
function FillWithAnswer({ field, form, roles, disabled, locale, onChange, label, noneLabel, optionLabel, hint, missing }: { field: PlacedField; form: FormDefinition; roles: readonly SignRole[]; disabled: boolean; locale: SignLocale; onChange: (change: FieldChange, coalesceKey?: string) => void; label: string; noneLabel: string; optionLabel: string; hint: string; missing: (key: string) => string }) {
  const options = bindableFields(form, field);
  const target = field.data ? form.fields.find((f) => f.key === field.data) : undefined;
  const id = `prop-fill-${field.key}`;
  const labelOf = (key: string) => {
    const f = form.fields.find((x) => x.key === key);
    return f ? pick(f.label, locale) || f.key : key;
  };
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-2.5">
      <FormRow label={label} htmlFor={id} hint={hint}>
        <NativeSelect
          id={id}
          value={field.data ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const key = e.target.value;
            const df = form.fields.find((f) => f.key === key);
            if (!df) onChange((f) => unbindPlacement(f, roles, roles[0]?.key));
            else onChange((f) => bindPlacement(f, df, takesOptionValue(df, f.type) ? df.options?.[0]?.value : undefined));
          }}
        >
          <option value="">{noneLabel}</option>
          {field.data && !target ? <option value={field.data}>{missing(field.data)}</option> : null}
          {target && !options.some((o) => o.key === target.key) ? <option value={target.key}>{labelOf(target.key)}</option> : null}
          {form.parts.map((part) => {
            const inPart = options.filter((o) => o.part === part.key);
            if (inPart.length === 0) return null;
            return (
              <optgroup key={part.key} label={pick(part.title, locale) || part.key}>
                {inPart.map((o) => (
                  <option key={o.key} value={o.key}>
                    {pick(o.label, locale) || o.key}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </NativeSelect>
      </FormRow>
      {target && takesOptionValue(target, field.type) ? (
        <FormRow label={optionLabel} htmlFor={`${id}-option`}>
          <NativeSelect id={`${id}-option`} value={field.dataValue ?? ""} disabled={disabled} onChange={(e) => onChange({ dataValue: e.target.value || undefined })}>
            {(target.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {pick(o.label, locale) || o.value}
              </option>
            ))}
            {field.dataValue !== undefined && !(target.options ?? []).some((o) => o.value === field.dataValue) ? <option value={field.dataValue}>{field.dataValue}</option> : null}
          </NativeSelect>
        </FormRow>
      ) : null}
    </div>
  );
}

/** Dropdown options, one per line. The text being typed is kept here so a trailing newline is not lost. */
function OptionsEditor({ id, options, disabled, onChange }: { id: string; options: string[]; disabled: boolean; onChange: (options: string[]) => void }) {
  const t = useTranslations("Sign.editor");
  const [text, setText] = useState(options.join("\n"));
  const parse = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const parsed = parse(text);
  const same = parsed.length === options.length && parsed.every((o, i) => o === options[i]);
  return (
    <FormRow label={t("props.options")} htmlFor={id} hint={t("props.optionsHint")}>
      <Textarea
        id={id}
        rows={4}
        value={same ? text : options.join("\n")}
        disabled={disabled}
        aria-invalid={options.length === 0 || new Set(options).size !== options.length}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parse(e.target.value));
        }}
      />
    </FormRow>
  );
}

function DateFormatControl({ id, value, disabled, onChange }: { id: string; value: string | undefined; disabled: boolean; onChange: (v: string | undefined) => void }) {
  const t = useTranslations("Sign.editor");
  const [custom, setCustom] = useState(false);
  const isPreset = value !== undefined && DATE_FORMAT_PRESETS.includes(value);
  const showCustom = custom || (value !== undefined && !isPreset);
  const selectValue = showCustom ? "__custom" : (value ?? "");
  return (
    <div className="space-y-2">
      <FormRow label={t("props.dateFormat")} htmlFor={id}>
        <NativeSelect
          id={id}
          value={selectValue}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === "__custom") {
              setCustom(true);
              if (value === undefined) onChange(DATE_FORMAT_PRESETS[0]);
            } else {
              setCustom(false);
              onChange(e.target.value || undefined);
            }
          }}
        >
          <option value="">{t("props.dateDefault")}</option>
          {DATE_FORMAT_PRESETS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value="__custom">{t("props.dateCustom")}</option>
        </NativeSelect>
      </FormRow>
      {showCustom ? (
        <FormRow label={t("props.dateCustomLabel")} htmlFor={`${id}-custom`} hint={t("props.dateCustomHint")}>
          <Input id={`${id}-custom`} value={value ?? ""} disabled={disabled} maxLength={30} onChange={(e) => onChange(e.target.value)} aria-invalid={!isValidDateFormat(value ?? "")} className="font-mono" />
        </FormRow>
      ) : null}
    </div>
  );
}

function MergeControl({ field, mergeKeys, inputId, disabled, onToggle, onKey }: { field: PlacedField; mergeKeys: readonly string[]; inputId: string; disabled: boolean; onToggle: (on: boolean) => void; onKey: (key: string) => void }) {
  const t = useTranslations("Sign.editor");
  const [typed, setTyped] = useState<string | null>(null);
  const on = !!field.merge;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-2.5">
      <label className="flex items-start gap-2 text-sm">
        <Checkbox className="mt-0.5" checked={on} disabled={disabled} onCheckedChange={(v) => onToggle(v === true)} />
        <span>
          {t("props.merge")}
          <span className="block text-xs text-muted-foreground">{field.role === SENDER_ROLE && !on ? t("props.mergeHintStatic") : t("props.mergeHint")}</span>
        </span>
      </label>
      {on ? (
        <FormRow label={t("props.mergeKey")} htmlFor={inputId}>
          <Input
            id={inputId}
            list={`${inputId}-list`}
            value={typed ?? field.merge ?? ""}
            disabled={disabled}
            maxLength={40}
            className="font-mono"
            onChange={(e) => {
              setTyped(e.target.value);
              const clean = sanitizeKey(e.target.value);
              if (clean) onKey(clean);
            }}
            onBlur={() => setTyped(null)}
          />
          <datalist id={`${inputId}-list`}>
            {mergeKeys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </FormRow>
      ) : null}
    </div>
  );
}
