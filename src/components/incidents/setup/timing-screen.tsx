"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeDue } from "@/lib/incidents/platform/pack";
import type { StepMode } from "@/lib/incidents/platform/timing";
import { api } from "./api";

export interface TimingStep {
  id: string;
  title: string;
  trigger_flag: string;
  role_key: string | null;
  shipped_hours: number | null;
  mode: StepMode;
  hours: number | null;
  enabled: boolean;
}
export interface TimingData {
  ack_wait_minutes: number;
  default_ack_wait_minutes: number;
  roles: { key: string; name: string }[];
  packs: { id: string; slug: string; name: string; legal: boolean; steps: TimingStep[] }[];
}
export interface StepChoice {
  mode: StepMode;
  hours: string;
  enabled: boolean;
}

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Timing a school can change: how long a notice may go unacknowledged, and the deadline of each built-in required step. Everything starts at the shipped value. */
export function TimingScreen() {
  const t = useTranslations("IncidentPlatform.timing");
  const [data, setData] = useState<TimingData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<TimingData>("/api/incidents/setup/timing");
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else setError(res.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  return (
    <TimingView
      data={data}
      onSaveAck={async (minutes) => {
        const res = await api<{ rules_updated: number }>("/api/incidents/setup/timing", "PUT", { ack_wait_minutes: minutes });
        if (!res.ok) return void toast.error(res.error);
        toast.success(t("ack.saved"));
        await load();
      }}
      onSaveStep={async (ruleId, choice) => {
        const res = await api("/api/incidents/setup/timing", "POST", { action: "step", rule_id: ruleId, mode: choice.mode, hours: choice.mode === "hours" ? choice.hours : undefined, enabled: choice.enabled });
        if (!res.ok) return void toast.error(res.error);
        toast.success(t("steps.saved"));
        await load();
      }}
    />
  );
}

export function TimingView({ data, onSaveAck, onSaveStep }: { data: TimingData; onSaveAck: (minutes: number) => Promise<void>; onSaveStep: (ruleId: string, choice: StepChoice) => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.timing");
  const tFlag = useTranslations("Incidents.flags");
  const roleName = (key: string | null) => (key ? (data.roles.find((r) => r.key === key)?.name ?? key) : t("steps.lead"));

  return (
    <div className="flex flex-col gap-6">
      <AckWait wait={data.ack_wait_minutes} fallback={data.default_ack_wait_minutes} onSave={onSaveAck} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("steps.title")}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("steps.help")}</p>
        {data.packs.length === 0 ? <p className="text-sm text-muted-foreground">{t("steps.none")}</p> : null}
        {data.packs.map((p) => (
          <div key={p.id} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{p.name}</h3>
            {p.legal ? <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">{t("steps.legal")}</p> : null}
            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
              {p.steps.map((s) => (
                <StepRow
                  key={s.id}
                  step={s}
                  sentence={t("steps.rowSentence", { involves: tFlag(s.trigger_flag), role: roleName(s.role_key), due: describeDue(s.shipped_hours) })}
                  onSave={(choice) => onSaveStep(s.id, choice)}
                />
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

function AckWait({ wait, fallback, onSave }: { wait: number; fallback: number; onSave: (minutes: number) => Promise<void> }) {
  const tAck = useTranslations("IncidentPlatform.timing.ack");
  const [value, setValue] = useState(String(wait));
  const [busy, setBusy] = useState(false);
  const save = async (minutes: number) => {
    setBusy(true);
    await onSave(minutes);
    setBusy(false);
  };
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 43200;

  return (
    <section className="flex max-w-2xl flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{tAck("title")}</h2>
      <p className="text-sm text-muted-foreground">{tAck("help", { default: fallback })}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save(n);
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          {tAck("label")}
          <Input className="w-28" type="number" min={1} max={43200} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <Button type="submit" size="sm" disabled={busy || !valid || n === wait}>{busy ? <Loader2 className="animate-spin" /> : null}{tAck("save")}</Button>
        {wait !== fallback ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setValue(String(fallback)); void save(fallback); }}>{tAck("reset", { default: fallback })}</Button> : null}
      </form>
    </section>
  );
}

function StepRow({ step, sentence, onSave }: { step: TimingStep; sentence: string; onSave: (choice: StepChoice) => Promise<void> }) {
  const tStep = useTranslations("IncidentPlatform.timing.steps");
  const [mode, setMode] = useState<StepMode>(step.mode);
  const [hours, setHours] = useState(step.hours ? String(step.hours) : "");
  const [enabled, setEnabled] = useState(step.enabled);
  const [busy, setBusy] = useState(false);

  const hoursOk = mode !== "hours" || (Number.isInteger(Number(hours)) && Number(hours) >= 1 && Number(hours) <= 8760 && hours !== "");
  const dirty = mode !== step.mode || enabled !== step.enabled || (mode === "hours" && hours !== String(step.hours ?? ""));
  const changed = step.mode !== "default" || !step.enabled;

  const save = async (choice: StepChoice) => {
    setBusy(true);
    await onSave(choice);
    setBusy(false);
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{step.title}</p>
          <p className="text-xs text-muted-foreground">{sentence}</p>
        </div>
        {changed ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs">{tStep("changed")}</span> : null}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {tStep("enabled")}
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {tStep("deadline")}
          <select className={selectClass} value={mode} onChange={(e) => setMode(e.target.value as StepMode)}>
            <option value="default">{tStep("mode.default", { due: describeDue(step.shipped_hours) })}</option>
            <option value="hours">{tStep("mode.hours")}</option>
            <option value="none">{tStep("mode.none")}</option>
          </select>
        </label>
        {mode === "hours" ? (
          <label className="flex flex-col gap-1 text-xs">
            {tStep("hours")}
            <Input className="w-24" type="number" min={1} max={8760} value={hours} onChange={(e) => setHours(e.target.value)} />
          </label>
        ) : null}
        <Button size="sm" disabled={busy || !dirty || !hoursOk} onClick={() => void save({ mode, hours, enabled })}>{busy ? <Loader2 className="animate-spin" /> : null}{tStep("save")}</Button>
        {changed ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save({ mode: "default", hours: "", enabled: true })}>{tStep("reset")}</Button> : null}
      </div>
      {!enabled ? <p className="text-xs text-muted-foreground">{tStep("off")}</p> : null}
    </li>
  );
}
