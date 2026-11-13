"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { INCIDENT_FLAGS } from "@/lib/incidents/constants";
import { describeRule, RULE_TRIGGERS, STEP_ROLE, TIMED_TRIGGERS, validateRule, type IncidentRule, type Namer, type RuleAction, type RuleTrigger } from "@/lib/incidents/platform/rules";
import { labelOf } from "@/lib/incidents/platform/roles";
import { api } from "./api";
import type { RulesResponse } from "./rules-screen";

type Unit = "minutes" | "hours" | "days";
const FACTOR: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

/** The best unit to show a wait in, so 1440 minutes reads as "1 day". */
function splitWait(minutes: number | null): { value: string; unit: Unit } {
  if (!minutes) return { value: "30", unit: "minutes" };
  if (minutes % 1440 === 0) return { value: String(minutes / 1440), unit: "days" };
  if (minutes % 60 === 0) return { value: String(minutes / 60), unit: "hours" };
  return { value: String(minutes), unit: "minutes" };
}

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Write or change a rule as a sentence: choose from lists, see the sentence and what it would do, save. */
export function RuleEditor({ data, rule, namer, onSaved, onCancel }: { data: RulesResponse; rule?: IncidentRule; namer: Namer; onSaved: () => Promise<void>; onCancel: () => void }) {
  const t = useTranslations("IncidentPlatform.rules.editor");
  const tFlag = useTranslations("Incidents.flags");
  const initialWait = splitWait(rule?.wait_minutes ?? null);

  const [name, setName] = useState(rule?.name ?? "");
  const [trigger, setTrigger] = useState<RuleTrigger>(rule?.trigger ?? "raised");
  const [waitValue, setWaitValue] = useState(initialWait.value);
  const [waitUnit, setWaitUnit] = useState<Unit>(initialWait.unit);
  const [categories, setCategories] = useState<string[]>(rule?.conditions.categories ?? []);
  const [flags, setFlags] = useState<string[]>(rule?.conditions.flags ?? []);
  const [minSeverity, setMinSeverity] = useState<string>(rule?.conditions.min_severity ?? "");
  const [level, setLevel] = useState<string>(rule?.conditions.level ? String(rule.conditions.level) : "");
  const [actions, setActions] = useState<RuleAction[]>(rule?.actions ?? [{ type: "notify", role_key: data.roles[0]?.key ?? "principal", ask_ack: false }]);
  const [busy, setBusy] = useState(false);

  const timed = TIMED_TRIGGERS.includes(trigger);
  const waitMinutes = timed ? Math.round(Number(waitValue) * FACTOR[waitUnit]) : null;
  const draft = useMemo(
    () => ({
      name,
      trigger,
      wait_minutes: waitMinutes,
      conditions: { categories, flags, min_severity: minSeverity || null, level: trigger === "escalated" && level ? (Number(level) as 2 | 3) : null },
      actions,
    }),
    [name, trigger, waitMinutes, categories, flags, minSeverity, level, actions],
  );
  const problems = validateRule(draft, data.roles.map((r) => r.key));
  const sentence = describeRule(draft, namer);

  const toggle = (list: string[], set: (v: string[]) => void, value: string) => set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  const patchAction = (i: number, next: RuleAction) => setActions((cur) => cur.map((a, j) => (j === i ? next : a)));

  const save = async () => {
    setBusy(true);
    const body = { name: name.trim(), wait_minutes: waitMinutes, conditions: draft.conditions, actions };
    const res = rule ? await api(`/api/incidents/setup/rules/${rule.id}`, "PATCH", body) : await api("/api/incidents/setup/rules", "POST", { ...body, trigger });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    await onSaved();
  };

  const chip = (on: boolean) => cn("rounded-full border px-2.5 py-1 text-xs", on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted");

  return (
    <form
      className="flex flex-col gap-4 rounded-xl border-2 border-primary/40 bg-card p-4"
      aria-label={rule ? t("editTitle") : t("newTitle")}
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0) void save();
      }}
    >
      <h3 className="text-sm font-semibold">{rule ? t("editTitle") : t("newTitle")}</h3>

      <label className="flex flex-col gap-1 text-xs">
        {t("name")}
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("when")}</legend>
        <div className="flex flex-wrap items-center gap-2">
          <select className={selectClass} value={trigger} onChange={(e) => setTrigger(e.target.value as RuleTrigger)} disabled={Boolean(rule)} aria-label={t("when")}>
            {RULE_TRIGGERS.map((k) => (
              <option key={k} value={k}>{t(`trigger.${k}`)}</option>
            ))}
          </select>
          {timed ? (
            <>
              <span className="text-sm text-muted-foreground">{t("after")}</span>
              <Input type="number" min={1} value={waitValue} onChange={(e) => setWaitValue(e.target.value)} className="w-20" aria-label={t("waitAmount")} />
              <select className={selectClass} value={waitUnit} onChange={(e) => setWaitUnit(e.target.value as Unit)} aria-label={t("waitUnit")}>
                {(["minutes", "hours", "days"] as const).map((u) => <option key={u} value={u}>{t(`unit.${u}`)}</option>)}
              </select>
            </>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("onlyIf")}</legend>
        <p className="text-xs text-muted-foreground">{t("onlyIfHelp")}</p>
        {data.template ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("categories")}>
            {data.template.categories.map((c) => (
              <button key={c.code} type="button" aria-pressed={categories.includes(c.code)} onClick={() => toggle(categories, setCategories, c.code)} className={chip(categories.includes(c.code))}>{c.name}</button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("involves")}>
          {INCIDENT_FLAGS.map((f) => (
            <button key={f} type="button" aria-pressed={flags.includes(f)} onClick={() => toggle(flags, setFlags, f)} className={chip(flags.includes(f))}>{tFlag(f)}</button>
          ))}
        </div>
        {data.template ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("severityAtLeast")}</span>
            <select className={selectClass} value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}>
              <option value="">{t("anySeverity")}</option>
              {data.template.severities.map((s) => <option key={s.slug} value={s.slug}>{s.label}</option>)}
            </select>
          </label>
        ) : null}
        {trigger === "escalated" ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("atLevel")}</span>
            <select className={selectClass} value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">{t("anyLevel")}</option>
              <option value="2">{t("level2")}</option>
              <option value="3">{t("level3")}</option>
            </select>
          </label>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("then")}</legend>
        {actions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
            {a.type === "notify" ? (
              <>
                <span className="text-sm">{t("tell")}</span>
                <select className={selectClass} value={a.role_key} onChange={(e) => patchAction(i, { ...a, role_key: e.target.value })} aria-label={t("role")}>
                  {data.roles.map((r) => <option key={r.key} value={r.key}>{labelOf(r.name)}</option>)}
                  {trigger === "step_overdue" ? <option value={STEP_ROLE}>{t("stepRole")}</option> : null}
                </select>
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={Boolean(a.ask_ack)} onChange={(e) => patchAction(i, { ...a, ask_ack: e.target.checked })} />
                  {t("askAck")}
                </label>
              </>
            ) : (
              <>
                <span className="text-sm">{t("markLevel")}</span>
                <select className={selectClass} value={a.level} onChange={(e) => patchAction(i, { type: "escalate", level: Number(e.target.value) === 3 ? 3 : 2 })} aria-label={t("level")}>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </>
            )}
            <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label={t("removeAction")} onClick={() => setActions((cur) => cur.filter((_, j) => j !== i))}><X /></Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setActions((cur) => [...cur, { type: "notify", role_key: data.roles[0]?.key ?? "principal", ask_ack: false }])}><Plus />{t("addTell")}</Button>
          {trigger !== "step_overdue" && trigger !== "escalated" ? <Button type="button" variant="outline" size="sm" onClick={() => setActions((cur) => [...cur, { type: "escalate", level: 2 }])}><Plus />{t("addLevel")}</Button> : null}
        </div>
      </fieldset>

      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-sm" aria-live="polite">
        <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("preview")}</p>
        <p><strong>{t("whenWord")}</strong> {sentence.when}</p>
        {sentence.onlyIf ? <p><strong>{t("onlyIfWord")}</strong> {sentence.onlyIf.replace(/^Only if /, "")}</p> : null}
        {sentence.then.map((line, i) => <p key={i}><strong>{i === 0 ? t("thenWord") : "+"}</strong> {line}</p>)}
      </div>

      {problems.length > 0 && name.length + actions.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || problems.length > 0}>{busy ? <Loader2 className="animate-spin" /> : null}{t("save")}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t("cancel")}</Button>
      </div>
    </form>
  );
}
