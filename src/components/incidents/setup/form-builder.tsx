"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import { AlertTriangle, ArrowDown, ArrowUp, Check, GripVertical, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { INCIDENT_FLAGS } from "@/lib/incidents/constants";
import { labelOf } from "@/lib/incidents/platform/roles";
import {
  FIELD_TYPES,
  addField,
  addOption,
  addStep,
  conditionCandidates,
  diffSchemas,
  moveField,
  moveStep,
  removeField,
  removeOption,
  removeStep,
  setCondition,
  updateField,
  updateOption,
  updateStep,
  validateSchema,
} from "@/lib/incidents/intake/form-edit";
import { SEVERITY_BANDS, type Effects, type FieldType, type FormField, type FormSchema } from "@/lib/incidents/intake/form-schema";
import { ReportApp } from "@/components/incidents/report/report-app";
import { REPORT_LANGS, REPORT_LANG_NAMES, type ReportLang } from "@/lib/incidents/intake/lang";
import type { LangMap } from "@/lib/incidents/platform/roles";
import { api } from "./api";

export interface VersionRow {
  id: string;
  version: number;
  status: "draft" | "published" | "archived";
  schema: FormSchema;
  note: string | null;
  created_at: string;
  published_at: string | null;
}
export interface FormData {
  builtIn: FormSchema;
  draft: VersionRow | null;
  published: VersionRow | null;
  allVersions: VersionRow[];
  categories: { code: string; name: string }[];
}

/** The wording in one language. English is required; another language that is left empty falls back to English on the coach's phone. */
const getL = (map: LangMap | undefined, lang: ReportLang) => map?.[lang] ?? "";
function setL(map: LangMap | undefined, lang: ReportLang, value: string): LangMap {
  const next: LangMap = { ...(map ?? {}) };
  if (lang !== "en" && value === "") delete next[lang];
  else next[lang] = value;
  return next;
}

const FIELD_MIME = "application/x-halo-field-key";
const TYPE_MIME = "application/x-halo-field-type";
const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** The coach report form builder. Drag a field type onto the form, drag fields to reorder, set each one on the right, preview on a phone, publish a version. */
export function FormBuilder() {
  const t = useTranslations("IncidentPlatform.builder");
  const [data, setData] = useState<FormData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const [lang, setLang] = useState<ReportLang>("en");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await api<FormData>("/api/incidents/setup/form");
    if (!res.ok) return void setError(res.error);
    setError(null);
    setData(res.data);
    setSchema(res.data.draft?.schema ?? null);
    setState("idle");
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  // Save the draft a moment after the last change, so nothing is lost and nobody has to remember to press Save.
  const edit = (next: FormSchema) => {
    setSchema(next);
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setState("saving");
      const res = await api("/api/incidents/setup/form", "PUT", { schema: next });
      setState(res.ok ? "saved" : "dirty");
      if (!res.ok) toast.error(res.error);
    }, 1200);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    if (timer.current) clearTimeout(timer.current);
    // Make sure the latest edit is saved before an action that reads the draft.
    if (schema && state !== "idle" && state !== "saved" && body.action === "publish") await api("/api/incidents/setup/form", "PUT", { schema });
    const res = await api("/api/incidents/setup/form", "POST", body);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    return res;
  };

  const problems = useMemo(() => (schema && data ? validateSchema(schema, { categoryCodes: data.categories.map((c) => c.code) }) : []), [schema, data]);

  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  const live = data.published?.schema ?? data.builtIn;

  if (!schema) {
    return (
      <div className="flex flex-col gap-6">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{data.published ? t("liveVersion", { version: data.published.version }) : t("builtIn")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("startHelp")}</p>
          <ol className="mt-3 list-decimal pl-5 text-sm">
            {live.steps.map((s) => <li key={s.key}>{labelOf(s.title)} <span className="text-muted-foreground">({s.fields.length})</span></li>)}
          </ol>
          <Button className="mt-4" size="sm" disabled={busy} onClick={async () => { if (await post({ action: "start" })) await load(); }}>{busy ? <Loader2 className="animate-spin" /> : null}{t("startDraft")}</Button>
        </section>
        <Versions data={data} draft={null} onRestore={async (v) => { if (await post({ action: "restore", version: v })) await load(); }} busy={busy} />
      </div>
    );
  }

  const selectedField = schema.steps.flatMap((s) => s.fields).find((f) => f.key === selected) ?? null;
  const previewView = { state: "open" as const, schema, mode: "test" as const, activity: { id: "PREVIEW", name: t("previewActivity"), venue: null, date: null }, coachName: t("previewCoach"), roster: [{ student_id: "P-1", name: "Test Student A", class: "Test class" }, { student_id: "P-2", name: "Test Student B", class: "Test class" }], returnUrl: null, expiresAt: "" };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          {t("wordingIn")}
          <select className={selectClass} value={lang} onChange={(e) => setLang(e.target.value as ReportLang)}>
            {REPORT_LANGS.map((l) => <option key={l} value={l}>{REPORT_LANG_NAMES[l]}</option>)}
          </select>
        </label>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {state === "saving" ? t("saving") : state === "dirty" ? t("unsaved") : state === "saved" ? t("saved") : t("draftOf", { version: data.draft?.version ?? 0 })}
        </p>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={async () => { if (window.confirm(t("discardConfirm")) && (await post({ action: "discard" }))) await load(); }}>{t("discard")}</Button>
          <Button size="sm" disabled={busy || problems.length > 0} onClick={async () => { if (await post({ action: "publish" })) { toast.success(t("published")); await load(); } }}>{busy ? <Loader2 className="animate-spin" /> : <Check />}{t("publish")}</Button>
        </div>
      </div>

      {problems.length > 0 ? (
        <section role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold"><AlertTriangle className="size-4 text-amber-500" />{t("beforePublish")}</h2>
          <ul className="mt-1 list-disc pl-5 text-sm">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[180px_1fr_300px]">
        <Palette onAdd={(type) => { const out = addField(schema, schema.steps[schema.steps.length - 1].key, type); edit(out.schema); setSelected(out.key); }} />
        <Canvas schema={schema} selected={selected} onSelect={setSelected} edit={edit} lang={lang} />
        <div className="flex flex-col gap-4">
          {selectedField ? <FieldSettings key={selectedField.key} schema={schema} field={selectedField} categories={data.categories} edit={edit} onDeleted={() => setSelected(null)} lang={lang} /> : <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("selectHelp")}</p>}
        </div>
      </div>

      <section aria-label={t("preview")} className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("preview")}</h2>
        <p className="text-xs text-muted-foreground">{t("previewHelp")}</p>
        <div className="mx-auto h-[640px] w-[360px] max-w-full overflow-y-auto rounded-[28px] border-8 border-foreground/80 bg-background shadow-lg">
          <ReportApp key={JSON.stringify(schema).length + schema.steps.length + lang} token="preview" view={previewView} origins={[]} preview lang={lang} />
        </div>
      </section>

      <Versions data={data} draft={schema} onRestore={async (v) => { if (window.confirm(t("restoreReplaces")) && (await post({ action: "discard" })) && (await post({ action: "restore", version: v }))) await load(); }} busy={busy} />
    </div>
  );
}

// ---- palette ----------------------------------------------------------------------------------------------------

export function Palette({ onAdd }: { onAdd: (type: FieldType) => void }) {
  const t = useTranslations("IncidentPlatform.builder");
  return (
    <aside aria-label={t("palette")} className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("palette")}</h2>
      <p className="text-xs text-muted-foreground">{t("paletteHelp")}</p>
      {FIELD_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(TYPE_MIME, type);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => onAdd(type)}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted"
        >
          <GripVertical className="size-4 text-muted-foreground" aria-hidden />
          {t(`type.${type}`)}
        </button>
      ))}
    </aside>
  );
}

// ---- canvas -----------------------------------------------------------------------------------------------------

function DropZone({ onDropType, onDropField, label }: { onDropType: (type: FieldType) => void; onDropField: (key: string) => void; label: string }) {
  const [over, setOver] = useState(false);
  return (
    <div
      role="presentation"
      aria-label={label}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TYPE_MIME) || e.dataTransfer.types.includes(FIELD_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const type = e.dataTransfer.getData(TYPE_MIME) as FieldType;
        const key = e.dataTransfer.getData(FIELD_MIME);
        if (type && FIELD_TYPES.includes(type)) onDropType(type);
        else if (key) onDropField(key);
      }}
      className={cn("h-3 rounded transition-all", over ? "my-1 h-8 border-2 border-dashed border-primary bg-primary/10" : "")}
    />
  );
}

export function Canvas({ schema, selected, onSelect, edit, lang = "en" }: { schema: FormSchema; selected: string | null; onSelect: (key: string | null) => void; edit: (next: FormSchema) => void; lang?: ReportLang }) {
  const t = useTranslations("IncidentPlatform.builder");
  const tType = useTranslations("IncidentPlatform.builder.type");
  return (
    <div className="flex flex-col gap-4" aria-label={t("canvas")}>
      {schema.steps.map((step, si) => (
        <section key={step.key} className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">{si + 1}</span>
            <Input value={getL(step.title, lang)} placeholder={lang === "en" ? undefined : step.title.en} onChange={(e) => edit(updateStep(schema, step.key, setL(step.title, lang, e.target.value)))} aria-label={t("stepTitle")} className="h-8 flex-1 font-semibold" />
            <Button variant="ghost" size="icon-sm" aria-label={t("stepUp")} disabled={si === 0} onClick={() => edit(moveStep(schema, step.key, si - 1))}><ArrowUp /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("stepDown")} disabled={si === schema.steps.length - 1} onClick={() => edit(moveStep(schema, step.key, si + 1))}><ArrowDown /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("stepDelete")} disabled={schema.steps.length <= 1} onClick={() => edit(removeStep(schema, step.key))}><Trash2 /></Button>
          </div>
          <div className="mt-2">
            <DropZone
              label={t("dropHere")}
              onDropType={(type) => { const out = addField(schema, step.key, type, 0); edit(out.schema); onSelect(out.key); }}
              onDropField={(key) => edit(moveField(schema, key, step.key, 0))}
            />
            {step.fields.length === 0 ? <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t("emptyStep")}</p> : null}
            {step.fields.map((f, fi) => (
              <div key={f.key}>
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FIELD_MIME, f.key);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  className={cn("flex items-center gap-2 rounded-lg border px-3 py-2", selected === f.key ? "border-primary bg-primary/5" : "border-border")}
                >
                  <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                  <button type="button" onClick={() => onSelect(f.key)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium">{labelOf(f.label, lang)}{f.required ? <span className="text-red-500"> *</span> : null}</span>
                    <span className="block truncate text-xs text-muted-foreground">{tType(f.type)}{f.showIf ? ` · ${t("conditional")}` : ""}</span>
                  </button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("fieldUp")} disabled={fi === 0 && si === 0} onClick={() => edit(fi > 0 ? moveField(schema, f.key, step.key, fi - 1) : moveField(schema, f.key, schema.steps[si - 1].key, schema.steps[si - 1].fields.length))}><ArrowUp /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("fieldDown")} disabled={fi === step.fields.length - 1 && si === schema.steps.length - 1} onClick={() => edit(fi < step.fields.length - 1 ? moveField(schema, f.key, step.key, fi + 2) : moveField(schema, f.key, schema.steps[si + 1].key, 0))}><ArrowDown /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("fieldDelete")} onClick={() => { edit(removeField(schema, f.key)); if (selected === f.key) onSelect(null); }}><Trash2 /></Button>
                </div>
                <DropZone
                  label={t("dropHere")}
                  onDropType={(type) => { const out = addField(schema, step.key, type, fi + 1); edit(out.schema); onSelect(out.key); }}
                  onDropField={(key) => edit(moveField(schema, key, step.key, fi + 1))}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
      <Button variant="outline" size="sm" className="self-start" disabled={schema.steps.length >= 6} onClick={() => edit(addStep(schema).schema)}><Plus />{t("addStep")}</Button>
    </div>
  );
}

// ---- one field --------------------------------------------------------------------------------------------------

function EffectsEditor({ effects, categories, withCategory, onChange }: { effects: Effects | undefined; categories: { code: string; name: string }[]; withCategory: boolean; onChange: (next: Effects | undefined) => void }) {
  const t = useTranslations("IncidentPlatform.builder");
  const tFlag = useTranslations("Incidents.flags");
  const tBand = useTranslations("IncidentPlatform.builder.band");
  const fx = effects ?? {};
  const set = (patch: Partial<Effects>) => {
    const next: Effects = { ...fx, ...patch };
    if (!next.category) delete next.category;
    if (!next.band) delete next.band;
    if (!next.flags?.length) delete next.flags;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2 text-xs">
      {withCategory ? (
        <label className="flex items-center gap-2">
          {t("filesUnder")}
          <select className={selectClass} value={fx.category ?? ""} onChange={(e) => set({ category: e.target.value || undefined })}>
            <option value="">{t("noCategory")}</option>
            {categories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
      ) : null}
      <label className="flex items-center gap-2">
        {t("severityIs")}
        <select className={selectClass} value={fx.band ?? ""} onChange={(e) => set({ band: (e.target.value || undefined) as Effects["band"] })}>
          <option value="">{t("noBand")}</option>
          {SEVERITY_BANDS.map((b) => <option key={b} value={b}>{tBand(b)}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-1" role="group" aria-label={t("flags")}>
        {INCIDENT_FLAGS.map((f) => {
          const on = fx.flags?.includes(f) ?? false;
          return (
            <button key={f} type="button" aria-pressed={on} onClick={() => set({ flags: on ? (fx.flags ?? []).filter((x) => x !== f) : [...(fx.flags ?? []), f] })} className={cn("rounded-full border px-2 py-0.5", on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{tFlag(f)}</button>
          );
        })}
      </div>
    </div>
  );
}

export function FieldSettings({ schema, field, categories, edit, onDeleted, lang = "en" }: { schema: FormSchema; field: FormField; categories: { code: string; name: string }[]; edit: (next: FormSchema) => void; onDeleted: () => void; lang?: ReportLang }) {
  const t = useTranslations("IncidentPlatform.builder");
  const tType = useTranslations("IncidentPlatform.builder.type");
  const candidates = conditionCandidates(schema, field.key);
  const dep = field.showIf ? candidates.find((c) => c.key === field.showIf?.field) : undefined;

  return (
    <section aria-label={t("settings")} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{tType(field.type)}</h2>
      <label className="flex flex-col gap-1 text-xs">
        {t("label")}
        <Input value={getL(field.label, lang)} placeholder={lang === "en" ? undefined : field.label.en} onChange={(e) => edit(updateField(schema, field.key, { label: setL(field.label, lang, e.target.value) }))} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t("help")}
        <Input value={getL(field.help, lang)} placeholder={lang === "en" ? undefined : field.help?.en} onChange={(e) => edit(updateField(schema, field.key, { help: e.target.value || lang !== "en" && field.help?.en ? setL(field.help, lang, e.target.value) : undefined }))} />
      </label>
      {field.type !== "photo" ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={Boolean(field.required)} onChange={(e) => edit(updateField(schema, field.key, { required: e.target.checked }))} />
          {t("required")}
        </label>
      ) : null}
      {field.type === "text" || field.type === "longtext" ? (
        <label className="flex items-center gap-2 text-xs">
          {t("maxLength")}
          <Input type="number" min={1} max={2000} value={field.maxLength ?? ""} onChange={(e) => edit(updateField(schema, field.key, { maxLength: e.target.value ? Number(e.target.value) : undefined }))} className="w-24" />
        </label>
      ) : null}

      {field.type === "choice" ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("options")}</h3>
          {(field.options ?? []).map((o) => (
            <div key={o.value} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
              <div className="flex gap-1">
                <Input value={getL(o.label, lang)} placeholder={lang === "en" ? undefined : o.label.en} onChange={(e) => edit(updateOption(schema, field.key, o.value, { label: setL(o.label, lang, e.target.value) }))} aria-label={t("optionLabel")} className="h-8" />
                <Button variant="ghost" size="icon-sm" aria-label={t("optionDelete")} onClick={() => edit(removeOption(schema, field.key, o.value))}><Trash2 /></Button>
              </div>
              <Input value={getL(o.help, lang)} onChange={(e) => edit(updateOption(schema, field.key, o.value, { help: e.target.value || lang !== "en" && o.help?.en ? setL(o.help, lang, e.target.value) : undefined }))} placeholder={lang === "en" ? t("optionHelp") : o.help?.en ?? t("optionHelp")} aria-label={t("optionHelp")} className="h-8" />
              <EffectsEditor effects={o.effects} categories={categories} withCategory onChange={(fx) => edit(updateOption(schema, field.key, o.value, { effects: fx }))} />
            </div>
          ))}
          <Button variant="outline" size="sm" className="self-start" disabled={(field.options?.length ?? 0) >= 12} onClick={() => edit(addOption(schema, field.key))}><Plus />{t("addOption")}</Button>
        </div>
      ) : null}

      {field.type === "yesno" ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("ifYes")}</h3>
          <EffectsEditor effects={field.ifYes} categories={categories} withCategory={false} onChange={(fx) => edit(updateField(schema, field.key, { ifYes: fx }))} />
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("showOnlyIf")}</h3>
        {candidates.length === 0 ? <p className="text-xs text-muted-foreground">{t("noCandidates")}</p> : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select className={selectClass} value={field.showIf?.field ?? ""} onChange={(e) => edit(setCondition(schema, field.key, e.target.value ? { field: e.target.value, equals: candidates.find((c) => c.key === e.target.value)?.options?.[0]?.value } : undefined))} aria-label={t("showOnlyIf")}>
              <option value="">{t("always")}</option>
              {candidates.map((c) => <option key={c.key} value={c.key}>{labelOf(c.label)}</option>)}
            </select>
            {dep ? (
              <>
                <span>{t("is")}</span>
                <select className={selectClass} value={field.showIf?.equals ?? ""} onChange={(e) => edit(setCondition(schema, field.key, { field: dep.key, equals: e.target.value }))} aria-label={t("is")}>
                  {(dep.options ?? []).map((o) => <option key={o.value} value={o.value}>{labelOf(o.label)}</option>)}
                </select>
              </>
            ) : null}
          </div>
        )}
      </div>

      <Button variant="destructive" size="sm" className="self-start" onClick={() => { edit(removeField(schema, field.key)); onDeleted(); }}><Trash2 />{t("fieldDelete")}</Button>
    </section>
  );
}

// ---- versions ---------------------------------------------------------------------------------------------------

export function Versions({ data, draft, onRestore, busy }: { data: FormData; draft: FormSchema | null; onRestore: (version: number) => void; busy: boolean }) {
  const t = useTranslations("IncidentPlatform.builder");
  const live = data.published?.schema ?? data.builtIn;
  const diff = draft ? diffSchemas(live, draft) : null;
  const rows = data.allVersions.filter((v) => v.status !== "draft");

  return (
    <section aria-label={t("versions")} className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("versions")}</h2>
      {diff ? (
        <div className="rounded-xl border border-border bg-card p-3 text-sm">
          <p className="mb-1 text-xs font-semibold">{t("changesFromLive")}</p>
          {diff.same ? <p className="text-muted-foreground">{t("noChanges")}</p> : (
            <ul className="list-disc pl-5">
              {diff.added.map((n) => <li key={`a-${n}`}>{t("diffAdded", { name: n })}</li>)}
              {diff.removed.map((n) => <li key={`r-${n}`}>{t("diffRemoved", { name: n })}</li>)}
              {diff.changed.map((n) => <li key={`c-${n}`}>{t("diffChanged", { name: n })}</li>)}
              {diff.moved.map((n) => <li key={`m-${n}`}>{t("diffMoved", { name: n })}</li>)}
            </ul>
          )}
        </div>
      ) : null}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("noVersions")}</p> : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
          {rows.map((v) => (
            <li key={v.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="font-medium">{t("versionNumber", { version: v.version })}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-medium", v.status === "published" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>{t(`status.${v.status}`)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{v.published_at ? format(new Date(v.published_at), "d MMM yyyy, HH:mm") : ""}{v.note ? ` · ${v.note}` : ""}</span>
              <Button variant="outline" size="sm" disabled={busy || v.status === "published" && !draft} onClick={() => onRestore(v.version)}>{t("restore")}</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
