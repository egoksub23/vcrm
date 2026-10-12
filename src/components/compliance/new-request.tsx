"use client";

// ============================================================
// Compliance requests, New request: a member of staff raises a case for something a customer asked in a chat or on the phone. The form is the type's own
// (its fields, in the person's language); the clock starts at the request date (now, or the day the customer asked: back-dating is recorded in the case's
// first event). Bank details typed here are encrypted by the server before they are stored. Documents are added on the case afterwards.
// ============================================================

import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FieldDef, RequestTypeRow } from "@/lib/compliance/types";
import { cn } from "@/lib/utils";

import { createRequest } from "./api";
import { answersFromForm, emptyForm, errorKey, fieldLabel, localInputToIso, missingRequired, typeLabel, type FormValues } from "./helpers";
import { Notice } from "./parts";

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** One field of a type's form, in the person's language. */
export function FieldInput({ field, value, onChange, invalid, idPrefix }: { field: FieldDef; value: string | boolean; onChange: (v: string | boolean) => void; invalid?: boolean; idPrefix: string }) {
  const locale = useLocale();
  const t = useTranslations("Compliance.form");
  const id = `${idPrefix}-${field.key}`;
  const label = fieldLabel(field, locale);
  const common = { id, "aria-invalid": invalid || undefined, "aria-describedby": invalid ? `${id}-error` : undefined } as const;
  if (field.type === "acknowledge") {
    return (
      <div>
        <label htmlFor={id} className="flex items-start gap-2 text-sm text-foreground">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined} />
          <span>
            {label}
            {field.required ? <span className="text-destructive"> *</span> : null}
          </span>
        </label>
        {invalid ? <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{t("mustTick")}</p> : null}
      </div>
    );
  }
  if (field.type === "file") {
    return (
      <p className="text-sm text-muted-foreground">
        {label}: {t("fileLater")}
      </p>
    );
  }
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-foreground">
        {label}
        {field.required ? <span className="text-destructive"> *</span> : null}
        {field.sensitive ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("encrypted")}</span> : null}
      </label>
      {field.type === "multiline" ? (
        <Textarea {...common} value={String(value)} onChange={(e) => onChange(e.target.value)} maxLength={2000} rows={3} />
      ) : field.type === "choice" ? (
        <select {...common} className={SELECT} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("choose")}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {(o.label as Record<string, string | undefined>)[locale] || o.label.en}
            </option>
          ))}
        </select>
      ) : field.type === "yesno" ? (
        <select {...common} className={SELECT} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("choose")}</option>
          <option value="true">{t("yes")}</option>
          <option value="false">{t("no")}</option>
        </select>
      ) : (
        <Input
          {...common}
          type={field.type === "date" ? "date" : field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text"}
          inputMode={field.type === "number" ? "decimal" : undefined}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          maxLength={field.type === "text" ? 300 : 100}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      {invalid ? <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{t("fixThis")}</p> : null}
    </div>
  );
}

export function NewRequest({ types, onCreated, onCancel }: { types: RequestTypeRow[]; onCreated: (id: string, reference: string) => void; onCancel: () => void }) {
  const t = useTranslations("Compliance.new");
  const tErr = useTranslations("Compliance.errors");
  const locale = useLocale();
  const active = useMemo(() => types.filter((x) => x.active), [types]);
  const [typeKey, setTypeKey] = useState(active[0]?.key ?? "");
  const type = active.find((x) => x.key === typeKey) ?? null;
  const [values, setValues] = useState<FormValues>(() => emptyForm(active[0]?.fields ?? []));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState("");
  const [received, setReceived] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());

  const pick = (key: string) => {
    setTypeKey(key);
    setValues(emptyForm(active.find((x) => x.key === key)?.fields ?? []));
    setInvalid(new Set());
    setError(null);
  };

  const missing = type ? missingRequired(type.fields, values) : [];
  const ready = !!type && name.trim() !== "" && missing.length === 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!type || !ready) return;
    setBusy(true);
    setError(null);
    setInvalid(new Set());
    const iso = localInputToIso(received);
    const res = await createRequest({
      typeKey: type.key,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      channel,
      ...(iso ? { receivedAt: iso } : {}),
      answers: answersFromForm(type.fields, values),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorKey(res.code));
      setInvalid(new Set((res.issues ?? []).map((i) => i.field ?? "")));
      return;
    }
    onCreated(res.data.id, res.data.reference);
  };

  if (!type) return <Notice>{t("noTypes")}</Notice>;

  return (
    <form onSubmit={submit} aria-label={t("title")} className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("intro")}</p>

      <div>
        <label htmlFor="cmp-new-type" className="mb-1 block text-sm font-medium text-foreground">
          {t("type")}
        </label>
        <select id="cmp-new-type" className={SELECT} value={typeKey} onChange={(e) => pick(e.target.value)}>
          {active.map((x) => (
            <option key={x.key} value={x.key}>
              {typeLabel({ typeLabel: x.label, typeLabelL10n: x.labelL10n }, locale)}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold text-foreground">{t("customer")}</legend>
        <div className="sm:col-span-2">
          <label htmlFor="cmp-new-name" className="mb-1 block text-sm font-medium text-foreground">
            {t("name")} <span className="text-destructive">*</span>
          </label>
          <Input id="cmp-new-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" aria-invalid={invalid.has("customer_name") || undefined} />
        </div>
        <div>
          <label htmlFor="cmp-new-email" className="mb-1 block text-sm font-medium text-foreground">
            {t("email")}
          </label>
          <Input id="cmp-new-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} autoComplete="off" aria-invalid={invalid.has("customer_email") || undefined} />
        </div>
        <div>
          <label htmlFor="cmp-new-phone" className="mb-1 block text-sm font-medium text-foreground">
            {t("phone")}
          </label>
          <Input id="cmp-new-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+60 12 345 6789" maxLength={40} autoComplete="off" aria-invalid={invalid.has("customer_phone") || undefined} />
        </div>
        <div>
          <label htmlFor="cmp-new-channel" className="mb-1 block text-sm font-medium text-foreground">
            {t("channel")}
          </label>
          <Input id="cmp-new-channel" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={t("channelPlaceholder")} maxLength={60} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="cmp-new-received" className="mb-1 block text-sm font-medium text-foreground">
            {t("received")}
          </label>
          <Input id="cmp-new-received" type="datetime-local" value={received} onChange={(e) => setReceived(e.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">{t("receivedHint")}</p>
        </div>
      </fieldset>

      <fieldset className={cn("grid gap-3")}>
        <legend className="mb-1 text-sm font-semibold text-foreground">{t("details")}</legend>
        {type.fields.map((f) => (
          <FieldInput key={`${type.key}-${f.key}`} idPrefix="cmp-new" field={f} value={values[f.key] ?? (f.type === "acknowledge" ? false : "")} onChange={(v) => setValues({ ...values, [f.key]: v })} invalid={invalid.has(f.key)} />
        ))}
      </fieldset>

      {error ? (
        <Notice tone="danger" icon={null}>
          {tErr(error)}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!ready}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("create")}
        </Button>
        {!ready && !busy ? <span className="text-xs text-muted-foreground">{t("requiredHint", { count: missing.length + (name.trim() === "" ? 1 : 0) })}</span> : null}
      </div>
    </form>
  );
}
