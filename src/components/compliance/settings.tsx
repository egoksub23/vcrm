"use client";

// ============================================================
// Settings > Compliance (compliance.manage): the request type definitions. For each type: its names, the clocks (days to the target and to the hard stop;
// they apply to NEW cases only, a case keeps the clock it was made with), whether an identity check, the dues block and the Head's pause are used, whether
// the type is on, and the operations checklist. The FIELDS of the three standard types are listed read-only (the staff form and, later, the public form
// are built on them); a custom type's fields are edited here. All of it goes through PATCH /api/compliance/types/[key].
// ============================================================

import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-auth";
import { cleanL10n, l10n, stepKeyFrom } from "@/lib/compliance/fields";
import { FIELD_TYPES, SENSITIVE_FIELD_TYPES, type ChecklistTemplateItem, type FieldDef, type FieldType, type RequestTypeRow } from "@/lib/compliance/types";
import { cn } from "@/lib/utils";

import { createType, getTypes, patchType } from "./api";
import { errorKey, fieldLabel } from "./helpers";
import { Notice } from "./parts";
import { PublicFormsSettings } from "./public-forms-settings";

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const LANGS = ["ms", "zh", "ko"] as const;

/** Parse "" as null (no clock) and a whole number as itself; anything else is invalid (undefined). */
export function parseDays(v: string): number | null | undefined {
  const t = v.trim();
  if (t === "") return null;
  if (!/^\d{1,3}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 ? n : undefined;
}

/** The clocks as the form keeps them, checked: both valid and the stop not before the target. */
export function clocksValid(target: string, stop: string): boolean {
  const a = parseDays(target);
  const b = parseDays(stop);
  if (a === undefined || b === undefined) return false;
  return a === null || b === null || b >= a;
}

function StepsEditor({ steps, onChange }: { steps: ChecklistTemplateItem[]; onChange: (s: ChecklistTemplateItem[]) => void }) {
  const t = useTranslations("Compliance.settings");
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const setLabel = (i: number, lang: "en" | "ms" | "zh" | "ko", value: string) => {
    const next = steps.map((s, k) => (k === i ? { ...s, label: { ...s.label, [lang]: value } } : s));
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.key} className="rounded-lg border border-border p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-5 text-center text-xs text-muted-foreground">{i + 1}</span>
              <Input aria-label={t("stepLabel", { n: i + 1 })} value={s.label.en} onChange={(e) => setLabel(i, "en", e.target.value)} maxLength={300} />
              <Button variant="ghost" size="icon-sm" aria-label={t("moveUp")} onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="size-3.5" aria-hidden /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("moveDown")} onClick={() => move(i, 1)} disabled={i === steps.length - 1}><ArrowDown className="size-3.5" aria-hidden /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("removeStep")} onClick={() => onChange(steps.filter((_, k) => k !== i))}><Trash2 className="size-3.5" aria-hidden /></Button>
            </div>
            <details className="mt-1 pl-6">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t("translations")}</summary>
              <div className="mt-1 grid gap-1.5 sm:grid-cols-3">
                {LANGS.map((l) => (
                  <Input key={l} aria-label={`${t("stepLabel", { n: i + 1 })} (${l})`} placeholder={l.toUpperCase()} value={(s.label as Record<string, string | undefined>)[l] ?? ""} onChange={(e) => setLabel(i, l, e.target.value)} maxLength={300} />
                ))}
              </div>
            </details>
          </li>
        ))}
      </ol>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...steps, { key: stepKeyFrom(`step ${steps.length + 1}`, new Set(steps.map((x) => x.key))), label: { en: "" } }])}
        disabled={steps.length >= 20}
      >
        <Plus className="size-3.5" aria-hidden />
        {t("addStep")}
      </Button>
    </div>
  );
}

function FieldsEditor({ fields, onChange }: { fields: FieldDef[]; onChange: (f: FieldDef[]) => void }) {
  const t = useTranslations("Compliance.settings");
  const tt = useTranslations("Compliance.settings.fieldTypes");
  const update = (i: number, patch: Partial<FieldDef>) => onChange(fields.map((f, k) => (k === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-2">
      {fields.map((f, i) => (
        <div key={f.key} className="grid gap-1.5 rounded-lg border border-border p-2 sm:grid-cols-[1fr_9rem_auto]">
          <Input aria-label={t("fieldLabel", { n: i + 1 })} value={f.label.en} onChange={(e) => update(i, { label: { ...f.label, en: e.target.value } })} maxLength={200} />
          <select aria-label={t("fieldType")} className={SELECT} value={f.type} onChange={(e) => update(i, { type: e.target.value as FieldType, sensitive: SENSITIVE_FIELD_TYPES.includes(e.target.value as FieldType) ? f.sensitive : false })}>
            {FIELD_TYPES.filter((x) => x !== "choice").map((x) => (
              <option key={x} value={x}>{tt(x)}</option>
            ))}
          </select>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.required} onChange={(e) => update(i, { required: e.target.checked })} className="size-4 accent-[var(--primary)]" />{t("required")}</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.sensitive} disabled={!SENSITIVE_FIELD_TYPES.includes(f.type)} onChange={(e) => update(i, { sensitive: e.target.checked })} className="size-4 accent-[var(--primary)]" />{t("sensitive")}</label>
            <Button variant="ghost" size="icon-sm" aria-label={t("removeField")} onClick={() => onChange(fields.filter((_, k) => k !== i))}><Trash2 className="size-3.5" aria-hidden /></Button>
          </div>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...fields, { key: stepKeyFrom(`field ${fields.length + 1}`, new Set(fields.map((x) => x.key))), type: "text", label: { en: "" }, required: false, sensitive: false }])}
        disabled={fields.length >= 40}
      >
        <Plus className="size-3.5" aria-hidden />
        {t("addField")}
      </Button>
    </div>
  );
}

export function TypeEditor({ type, onSaved }: { type: RequestTypeRow; onSaved: (t: RequestTypeRow) => void }) {
  const t = useTranslations("Compliance.settings");
  const tErr = useTranslations("Compliance.errors");
  const tc = useTranslations("Compliance");
  const locale = useLocale();
  const [label, setLabel] = useState(type.label);
  const [l10nMap, setL10nMap] = useState<Record<string, string>>({ ms: type.labelL10n.ms ?? "", zh: type.labelL10n.zh ?? "", ko: type.labelL10n.ko ?? "" });
  const [target, setTarget] = useState(type.targetDays === null ? "" : String(type.targetDays));
  const [stop, setStop] = useState(type.hardStopDays === null ? "" : String(type.hardStopDays));
  const [identity, setIdentity] = useState(type.requiresIdentityCheck);
  const [dues, setDues] = useState(type.checkDues);
  const [pause, setPause] = useState(type.allowPause);
  const [active, setActive] = useState(type.active);
  const [steps, setSteps] = useState<ChecklistTemplateItem[]>(type.checklist);
  const [fields, setFields] = useState<FieldDef[]>(type.fields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const clocksOk = clocksValid(target, stop);
  const stepsOk = steps.every((s) => s.label.en.trim() !== "");
  const fieldsOk = type.isSystem || (fields.length > 0 && fields.every((f) => f.label.en.trim() !== ""));
  const ok = label.trim() !== "" && clocksOk && stepsOk && fieldsOk && !busy;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const body: Record<string, unknown> = {
      label,
      labelL10n: l10nMap,
      targetDays: parseDays(target) ?? null,
      hardStopDays: parseDays(stop) ?? null,
      requiresIdentityCheck: identity,
      checkDues: dues,
      allowPause: pause,
      active,
      checklist: steps.map((s) => ({ key: s.key, label: cleanL10n(s.label, 300) ?? s.label })),
    };
    if (!type.isSystem) body.fields = fields.map((f) => ({ ...f, label: cleanL10n(f.label) ?? f.label }));
    const res = await patchType(type.key, body);
    setBusy(false);
    if (!res.ok) {
      setError(errorKey(res.code));
      return;
    }
    setSaved(true);
    onSaved(res.data.type);
  };

  const idp = `cmp-type-${type.key}`;
  return (
    <section aria-labelledby={`${idp}-title`} className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${idp}-title`} className="text-base font-semibold text-foreground">{l10n({ en: type.label, ...type.labelL10n }, locale)}</h3>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{type.key}</code>
        {type.isSystem ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t("standard")}</span> : null}
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4 accent-[var(--primary)]" />
          {t("active")}
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={`${idp}-label`} className="mb-1 block text-sm font-medium">{t("name")}</label>
          <Input id={`${idp}-label`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
        </div>
        {LANGS.map((l) => (
          <div key={l}>
            <label htmlFor={`${idp}-${l}`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("nameIn", { language: t(`languages.${l}`) })}</label>
            <Input id={`${idp}-${l}`} value={l10nMap[l]} onChange={(e) => setL10nMap({ ...l10nMap, [l]: e.target.value })} maxLength={120} />
          </div>
        ))}
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold">{t("clocks")}</legend>
        <div>
          <label htmlFor={`${idp}-target`} className="mb-1 block text-sm font-medium">{t("targetDays")}</label>
          <Input id={`${idp}-target`} inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t("noClock")} aria-invalid={parseDays(target) === undefined || undefined} />
        </div>
        <div>
          <label htmlFor={`${idp}-stop`} className="mb-1 block text-sm font-medium">{t("stopDays")}</label>
          <Input id={`${idp}-stop`} inputMode="numeric" value={stop} onChange={(e) => setStop(e.target.value)} placeholder={t("noClock")} aria-invalid={!clocksOk || undefined} />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">{clocksOk ? t("clocksHint") : t("clocksInvalid")}</p>
      </fieldset>

      <div className="space-y-1.5">
        {([[identity, setIdentity, "identityCheck"], [dues, setDues, "dues"], [pause, setPause, "pause"]] as const).map(([value, setter, key]) => (
          <label key={key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={value} onChange={(e) => setter(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
            <span>
              {t(`switches.${key}`)}
              <span className="block text-xs text-muted-foreground">{t(`switches.${key}Hint`)}</span>
            </span>
          </label>
        ))}
      </div>

      <div>
        <h4 className="mb-1 text-sm font-semibold">{t("checklist")}</h4>
        <p className="mb-2 text-xs text-muted-foreground">{t("checklistHint")}</p>
        <StepsEditor steps={steps} onChange={setSteps} />
      </div>

      <div>
        <h4 className="mb-1 text-sm font-semibold">{t("fields")}</h4>
        {type.isSystem ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">{t("fieldsFixed")}</p>
            <ul className="space-y-1 text-sm">
              {type.fields.map((f) => (
                <li key={f.key} className="flex flex-wrap items-center gap-2">
                  <span>{fieldLabel(f, locale)}</span>
                  <span className="text-xs text-muted-foreground">{t(`fieldTypes.${f.type}`)}</span>
                  {f.required ? <span className="text-xs text-muted-foreground">{t("required")}</span> : null}
                  {f.sensitive ? <span className="rounded-full bg-muted px-1.5 text-[10px]">{t("sensitive")}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <FieldsEditor fields={fields} onChange={setFields} />
        )}
      </div>

      {error ? <Notice tone="danger">{tErr(error)}</Notice> : null}
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={!ok}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {tc("save")}
        </Button>
        {saved ? <span role="status" className="text-sm text-muted-foreground">{t("saved")}</span> : null}
      </div>
    </section>
  );
}

export function NewTypeForm({ onCreated, onCancel }: { onCreated: (t: RequestTypeRow) => void; onCancel: () => void }) {
  const t = useTranslations("Compliance.settings");
  const tErr = useTranslations("Compliance.errors");
  const [label, setLabel] = useState("");
  const [fields, setFields] = useState<FieldDef[]>([{ key: "details", type: "multiline", label: { en: "Details" }, required: true, sensitive: false }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = stepKeyFrom(label, new Set());
  const ok = label.trim() !== "" && fields.length > 0 && fields.every((f) => f.label.en.trim() !== "") && !busy;
  return (
    <section aria-label={t("newType")} className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h3 className="text-base font-semibold">{t("newType")}</h3>
      <div>
        <label htmlFor="cmp-newtype-label" className="mb-1 block text-sm font-medium">{t("name")}</label>
        <Input id="cmp-newtype-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
        <p className="mt-1 text-xs text-muted-foreground">{t("keyWillBe")} <code className="rounded bg-muted px-1">{key}</code></p>
      </div>
      <FieldsEditor fields={fields} onChange={setFields} />
      {error ? <Notice tone="danger">{tErr(error)}</Notice> : null}
      <div className="flex gap-2">
        <Button
          disabled={!ok}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const res = await createType({ key, label, fields: fields.map((f) => ({ ...f, label: cleanL10n(f.label) ?? f.label })), targetDays: null, hardStopDays: null });
            setBusy(false);
            if (!res.ok) setError(errorKey(res.code));
            else onCreated(res.data.type);
          }}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("createType")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t("cancel")}</Button>
      </div>
    </section>
  );
}

export function ComplianceSettingsPanel() {
  const t = useTranslations("Compliance.settings");
  const tErr = useTranslations("Compliance.errors");
  const canManage = useCapability("compliance.manage");
  const [types, setTypes] = useState<RequestTypeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await getTypes();
    if (!res.ok) {
      setError(errorKey(res.code));
      return;
    }
    setError(null);
    setTypes(res.data.types);
  }, []);
  useEffect(() => {
    // load-on-mount fetch whose result sets state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (canManage) void load();
  }, [canManage, load]);

  if (!canManage) return <Notice>{t("noPermission")}</Notice>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      {error ? <Notice tone="danger">{tErr(error)}</Notice> : null}
      {types === null && !error ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />{t("loading")}</p> : null}
      {types?.map((ty) => (
        <TypeEditor key={`${ty.key}-${ty.checklist.length}-${ty.fields.length}`} type={ty} onSaved={(saved) => setTypes((all) => all?.map((x) => (x.key === saved.key ? saved : x)) ?? all)} />
      ))}
      <PublicFormsSettings />
      {adding ? (
        <NewTypeForm
          onCancel={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false);
            setTypes((all) => [...(all ?? []), created]);
          }}
        />
      ) : types ? (
        <Button variant="outline" onClick={() => setAdding(true)} className={cn(types.length === 0 && "mt-2")}>
          <Plus className="size-4" aria-hidden />
          {t("newType")}
        </Button>
      ) : null}
    </div>
  );
}
