"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Play, Plus, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { INCIDENT_FLAGS } from "@/lib/incidents/constants";
import { describeRule, WARNING_TEXT, type IncidentRule, type Namer } from "@/lib/incidents/platform/rules";
import { labelOf, type LangMap, type ResolveWarning } from "@/lib/incidents/platform/roles";
import type { IncidentSeverityLevel, IncidentTypeCatalogueEntry } from "@/lib/incidents/standard-types";
import { api } from "./api";
import { RuleEditor } from "./rule-editor";

export interface RulesResponse {
  rules: IncidentRule[];
  recipes: { key: string; name: string; description: string; inStarterSet: boolean; needs: string | null; added: boolean }[];
  template: { id: string; name: string; categories: IncidentTypeCatalogueEntry[]; severities: IncidentSeverityLevel[] } | null;
  roles: { key: string; name: LangMap; kind: string; warnings: ResolveWarning[] }[];
}

interface TryResponse {
  notices: { after: number; ruleName: string; roleKey: string; roleName: string; askAck: boolean; people: { name: string; address: string }[]; warnings: ResolveWarning[] }[];
  escalations: { after: number; ruleName: string; level: number }[];
  warnings: string[];
  enabledRules: number;
}

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Words for the names that appear in a rule's sentence, from the school's template and roles. */
export function makeNamer(data: RulesResponse | null, flagNoun: (flag: string) => string): Namer {
  const cats = new Map((data?.template?.categories ?? []).map((c) => [c.code, c.name]));
  const sevs = new Map((data?.template?.severities ?? []).map((s) => [s.slug, s.label]));
  const roles = new Map((data?.roles ?? []).map((r) => [r.key, labelOf(r.name)]));
  return {
    role: (k) => roles.get(k) ?? k,
    category: (c) => cats.get(c) ?? c,
    severity: (s) => sevs.get(s) ?? s,
    flag: (f) => ((INCIDENT_FLAGS as readonly string[]).includes(f) ? flagNoun(f) : f),
  };
}

function whenText(after: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (after === 0) return t("tryNow");
  if (after % 1440 === 0) return t("tryAfterDays", { n: after / 1440 });
  if (after % 60 === 0) return t("tryAfterHours", { n: after / 60 });
  return t("tryAfterMinutes", { n: after });
}

/** Rules: each one reads as a sentence. Start from a recipe, switch it on, and Try it before a real incident does. */
export function RulesScreen() {
  const t = useTranslations("IncidentPlatform.rules");
  const tFlag = useTranslations("IncidentPlatform.flagNoun");
  const [data, setData] = useState<RulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<RulesResponse>("/api/incidents/setup/rules");
    if (!res.ok) return void setError(res.error);
    setError(null);
    setData(res.data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  const namer: Namer = useMemo(() => makeNamer(data, tFlag), [data, tFlag]);

  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;
  return <RulesView data={data} namer={namer} reload={load} />;
}

/** The screen once the data is in. Separate from the loader so it can be rendered with sample data in tests. */
export function RulesView({ data, namer, reload: load }: { data: RulesResponse; namer: Namer; reload: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.rules");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const toAdd = data.recipes.filter((r) => !r.added);
  const starterLeft = toAdd.filter((r) => r.inStarterSet).length;
  const emptyRoles = new Map(data.roles.filter((r) => r.warnings.length > 0).map((r) => [r.key, r.warnings]));

  const addRecipe = async (key: string) => {
    const res = await api("/api/incidents/setup/rules", "POST", { recipe_key: key });
    if (!res.ok) return void toast.error(res.error);
    await load();
  };
  const addStarter = async () => {
    const res = await api<{ added: number }>("/api/incidents/setup/rules", "POST", { starter: true });
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("starterAdded", { count: res.data.added }));
    await load();
  };
  const toggle = async (rule: IncidentRule, enabled: boolean) => {
    const res = await api(`/api/incidents/setup/rules/${rule.id}`, "PATCH", { enabled });
    if (!res.ok) return void toast.error(res.error);
    await load();
  };
  const remove = async (rule: IncidentRule) => {
    const res = await api(`/api/incidents/setup/rules/${rule.id}`, "DELETE");
    if (!res.ok) return void toast.error(res.error);
    await load();
  };
  const setWait = async (rule: IncidentRule, wait: number) => {
    const res = await api(`/api/incidents/setup/rules/${rule.id}`, "PATCH", { wait_minutes: wait });
    if (!res.ok) return void toast.error(res.error);
    await load();
  };
  const setMinSeverity = async (rule: IncidentRule, slug: string) => {
    const res = await api(`/api/incidents/setup/rules/${rule.id}`, "PATCH", { conditions: { ...rule.conditions, min_severity: slug || null } });
    if (!res.ok) return void toast.error(res.error);
    await load();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-4">
        {starterLeft > 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
            <Sparkles className="size-5 text-primary" />
            <p className="min-w-0 flex-1 text-sm">{t("starterHelp", { count: starterLeft })}</p>
            <Button size="sm" onClick={() => void addStarter()}>{t("starterButton")}</Button>
          </div>
        ) : null}

        <div>
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}><Plus />{t("newRule")}</Button>
        </div>
        {editing === "new" ? (
          <RuleEditor
            data={data}
            namer={namer}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
            }}
          />
        ) : null}

        {data.rules.length === 0 ? <p className="text-sm text-muted-foreground">{t("noRules")}</p> : null}
        <ul className="flex flex-col gap-3">
          {data.rules.map((rule) => {
            const sentence = describeRule(rule, namer);
            const missing = rule.actions.flatMap((a) => (a.type === "notify" && emptyRoles.has(a.role_key) ? [namer.role(a.role_key)] : []));
            if (editing === rule.id) {
              return (
                <li key={rule.id}>
                  <RuleEditor
                    data={data}
                    rule={rule}
                    namer={namer}
                    onCancel={() => setEditing(null)}
                    onSaved={async () => {
                      setEditing(null);
                      await load();
                    }}
                  />
                </li>
              );
            }
            return (
              <li key={rule.id} className={cn("rounded-xl border bg-card p-4", rule.enabled ? "border-border" : "border-dashed border-border opacity-80")}>
                <div className="flex items-start gap-3">
                  <h3 className="min-w-0 flex-1 text-sm font-semibold">{rule.name}</h3>
                  <Switch checked={rule.enabled} onCheckedChange={(v) => void toggle(rule, v)} aria-label={t("switch", { name: rule.name })} />
                  <Button variant="ghost" size="sm" onClick={() => setEditing(rule.id)}>{t("editRule")}</Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("delete")} onClick={() => void remove(rule)}><Trash2 /></Button>
                </div>
                <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("when")}</dt>
                  <dd>{sentence.when}</dd>
                  {sentence.onlyIf ? (
                    <>
                      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("onlyIf")}</dt>
                      <dd>{sentence.onlyIf.replace(/^Only if /, "")}</dd>
                    </>
                  ) : null}
                  <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("then")}</dt>
                  <dd>
                    <ul className="flex flex-col gap-0.5">{sentence.then.map((line, i) => <li key={i}>{line}</li>)}</ul>
                  </dd>
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {rule.wait_minutes != null ? (
                    <label className="flex items-center gap-1.5">
                      {t("waitMinutes")}
                      <input
                        type="number"
                        min={1}
                        max={43200}
                        defaultValue={rule.wait_minutes}
                        className={cn(selectClass, "w-20")}
                        onBlur={(e) => Number(e.target.value) !== rule.wait_minutes && Number(e.target.value) >= 1 && void setWait(rule, Number(e.target.value))}
                      />
                    </label>
                  ) : null}
                  {data.template && rule.conditions.min_severity !== undefined && rule.conditions.min_severity !== null ? (
                    <label className="flex items-center gap-1.5">
                      {t("severityAtLeast")}
                      <select className={selectClass} value={rule.conditions.min_severity ?? ""} onChange={(e) => void setMinSeverity(rule, e.target.value)}>
                        <option value="">{t("anySeverity")}</option>
                        {data.template.severities.map((s) => <option key={s.slug} value={s.slug}>{s.label}</option>)}
                      </select>
                    </label>
                  ) : null}
                </div>
                {missing.length > 0 && rule.enabled ? (
                  <p role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                    {t("roleEmpty", { roles: [...new Set(missing)].join(", ") })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>

        {toAdd.length > 0 ? (
          <section aria-label={t("recipes")} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("recipes")}</h3>
            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
              {toAdd.map((r) => (
                <li key={r.key} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">{r.description}</p>
                    {r.needs ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{r.needs}</p> : null}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void addRecipe(r.key)}><Plus />{t("addRecipe")}</Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <TryIt data={data} />
    </div>
  );
}

// ---- Try it -----------------------------------------------------------------------------------------------------

function TryIt({ data }: { data: RulesResponse }) {
  const t = useTranslations("IncidentPlatform.rules");
  const tFlag = useTranslations("Incidents.flags");
  const tWarn = useTranslations("IncidentPlatform.warnings");
  const cats = data.template?.categories ?? [];
  const sevs = data.template?.severities ?? [];
  const [category, setCategory] = useState(cats[0]?.code ?? "");
  const [severity, setSeverity] = useState(sevs[1]?.slug ?? sevs[0]?.slug ?? "");
  const [flags, setFlags] = useState<string[]>([]);
  const [result, setResult] = useState<TryResponse | null>(null);
  const [busy, setBusy] = useState(false);

  if (!data.template) return <aside className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{t("noTemplate")}</aside>;

  const run = async () => {
    setBusy(true);
    const res = await api<TryResponse>("/api/incidents/setup/rules/try", "POST", { category, severity, flags });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setResult(res.data);
  };
  const pickCategory = (code: string) => {
    setCategory(code);
    // A category starts with its own flags, as a real incident would.
    setFlags(cats.find((c) => c.code === code)?.default_flags ?? []);
  };

  return (
    <aside className="flex h-fit flex-col gap-3 rounded-xl border border-border bg-card p-4 lg:sticky lg:top-4" aria-label={t("tryTitle")}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Play className="size-3.5" />{t("tryTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("tryHelp")}</p>
      <label className="flex flex-col gap-1 text-xs">
        {t("tryCategory")}
        <select className={selectClass} value={category} onChange={(e) => pickCategory(e.target.value)}>
          {cats.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t("trySeverity")}
        <select className={selectClass} value={severity} onChange={(e) => setSeverity(e.target.value)}>
          {sevs.map((s) => <option key={s.slug} value={s.slug}>{s.label}</option>)}
        </select>
      </label>
      <fieldset className="flex flex-wrap gap-1.5">
        <legend className="mb-1 text-xs">{t("tryFlags")}</legend>
        {INCIDENT_FLAGS.map((f) => {
          const on = flags.includes(f);
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              onClick={() => setFlags((cur) => (on ? cur.filter((x) => x !== f) : [...cur, f]))}
              className={cn("rounded-full border px-2.5 py-1 text-xs", on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}
            >
              {tFlag(f)}
            </button>
          );
        })}
      </fieldset>
      <Button size="sm" onClick={() => void run()} disabled={busy || !category || !severity}>{busy ? <Loader2 className="animate-spin" /> : <Play />}{t("tryRun")}</Button>

      {result ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm" aria-live="polite">
          <p className="text-xs text-muted-foreground">{t("tryNothingSent")}</p>
          {result.notices.length === 0 && result.escalations.length === 0 ? <p className="text-sm">{t("tryNobody", { count: result.enabledRules })}</p> : null}
          <ol className="flex flex-col gap-2">
            {[...result.notices.map((n) => ({ ...n, kind: "notice" as const })), ...result.escalations.map((e) => ({ ...e, kind: "escalation" as const }))]
              .sort((a, b) => a.after - b.after)
              .map((item, i) =>
                item.kind === "notice" ? (
                  <li key={i} className="rounded-lg bg-muted/50 px-3 py-2">
                    <p className="text-xs font-semibold">{whenText(item.after, t)}</p>
                    <p>
                      {item.roleName}
                      {item.askAck ? <span className="text-xs text-muted-foreground"> · {t("tryAck")}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.people.length ? item.people.map((p) => (p.address ? `${p.name} (${p.address})` : p.name)).join(", ") : t("tryNoOne")}
                    </p>
                  </li>
                ) : (
                  <li key={i} className="rounded-lg bg-muted/50 px-3 py-2">
                    <p className="text-xs font-semibold">{whenText(item.after, t)}</p>
                    <p>{t("tryLevel", { level: item.level })}</p>
                  </li>
                ),
              )}
          </ol>
          {result.warnings.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-amber-700 dark:text-amber-400">
              {result.notices
                .filter((n) => n.warnings.length > 0)
                .map((n) => (
                  <li key={n.roleKey} className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    {n.roleName}: {n.warnings.map((w) => tWarn(w)).join("; ") || WARNING_TEXT[n.warnings[0]]}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
