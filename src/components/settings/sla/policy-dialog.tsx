"use client";

import { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { splitMinutes, toMinutes } from "@/lib/sla/business-time";
import { previewPolicy, toBusinessSchedule, validatePolicyPayload } from "@/lib/sla/policy";
import { SLA_CHANNELS, SLA_LIMITS, type PolicyConditions, type SlaErrorCode, type SlaPolicy, type SlaSchedule } from "@/lib/sla/types";
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "@/lib/tickets/constants";
import { normalizeLabel } from "@/lib/tickets/labels";
import type { Team } from "@/types";
import { slaApi } from "./sla-api";

type Unit = "minutes" | "hours" | "days";

interface TargetDraft {
  on: boolean;
  value: string;
  unit: Unit;
}

const targetFrom = (minutes: number | null, fallback: number): TargetDraft => {
  if (minutes === null) return { on: false, value: String(fallback), unit: "hours" };
  const s = splitMinutes(minutes);
  return { on: true, value: String(s.value), unit: s.unit };
};

const minutesOf = (t: TargetDraft): number | null => {
  if (!t.on) return null;
  const v = Number(t.value);
  return Number.isFinite(v) && v > 0 ? toMinutes(v, t.unit) : NaN;
};

const NO_SCHEDULE = "__24_7__";

/** A row of toggle chips: nothing selected means "any". */
function ChipSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useTranslations("Settings.sla.policies");
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-foreground">
        {label}
        {selected.length === 0 ? <span className="ml-2 text-xs font-normal text-muted-foreground">{t("any")}</span> : null}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                on
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TargetField({
  label,
  hint,
  draft,
  onChange,
  idPrefix,
}: {
  label: string;
  hint: string;
  draft: TargetDraft;
  onChange: (next: TargetDraft) => void;
  idPrefix: string;
}) {
  const t = useTranslations("Settings.sla.policies");
  return (
    <div className="space-y-1.5 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${idPrefix}-value`} className="text-foreground">
          {label}
        </Label>
        <Switch
          checked={draft.on}
          aria-label={t("targetOn", { target: label })}
          onCheckedChange={(on) => onChange({ ...draft, on })}
        />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex items-center gap-2">
        <Input
          id={`${idPrefix}-value`}
          type="number"
          min={1}
          step="any"
          inputMode="decimal"
          value={draft.value}
          disabled={!draft.on}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
          className="w-28 bg-muted"
        />
        <select
          value={draft.unit}
          disabled={!draft.on}
          aria-label={t("unit")}
          onChange={(e) => onChange({ ...draft, unit: e.target.value as Unit })}
          className="h-9 rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
        >
          {(["minutes", "hours", "days"] as const).map((u) => (
            <option key={u} value={u}>
              {t(`units.${u}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * Create or edit one SLA policy. The live preview at the bottom is computed
 * with the same business-hours maths the database uses (src/lib/sla).
 */
export function PolicyDialog({
  open,
  onOpenChange,
  policy,
  schedules,
  teams,
  knownLabels,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: SlaPolicy | null;
  schedules: SlaSchedule[];
  teams: Team[];
  knownLabels: string[];
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        {open ? (
          <PolicyEditor
            key={policy?.id ?? "new"}
            policy={policy}
            schedules={schedules}
            teams={teams}
            knownLabels={knownLabels}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog body (exported for the render tests). */
export function PolicyEditor({
  policy,
  schedules,
  teams,
  knownLabels,
  onClose,
  onSaved,
}: {
  policy: SlaPolicy | null;
  schedules: SlaSchedule[];
  teams: Team[];
  knownLabels: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Settings.sla.policies");
  const tErr = useTranslations("Settings.sla.errors");
  const tCat = useTranslations("Tickets.detail.category");
  const tPri = useTranslations("Tickets.detail.priority");
  const tCh = useTranslations("Settings.sla.channels");
  const format = useFormatter();

  const defaultSchedule = schedules.find((s) => s.is_default) ?? null;
  const [name, setName] = useState(policy?.name ?? "");
  const [active, setActive] = useState(policy?.is_active ?? true);
  const [cond, setCond] = useState<PolicyConditions>(policy?.conditions ?? {});
  const [labelInput, setLabelInput] = useState("");
  const [first, setFirst] = useState<TargetDraft>(() => targetFrom(policy ? policy.first_response_minutes : 60, 1));
  const [resolution, setResolution] = useState<TargetDraft>(() => targetFrom(policy ? policy.resolution_minutes : 1440, 24));
  const [scheduleId, setScheduleId] = useState<string>(policy ? (policy.schedule_id ?? NO_SCHEDULE) : (defaultSchedule?.id ?? NO_SCHEDULE));
  const [pause, setPause] = useState(policy?.pause_while_pending ?? true);
  const [atRisk, setAtRisk] = useState(String(policy?.at_risk_percent ?? SLA_LIMITS.atRiskDefault));
  const [error, setError] = useState<SlaErrorCode | null>(null);
  const [saving, setSaving] = useState(false);

  const setList = (key: keyof PolicyConditions, next: string[]) => setCond((c) => ({ ...c, [key]: next }));
  const addLabel = () => {
    const label = normalizeLabel(labelInput);
    if (label && !(cond.labels ?? []).includes(label)) setList("labels", [...(cond.labels ?? []), label]);
    setLabelInput("");
  };

  const frMin = minutesOf(first);
  const resMin = minutesOf(resolution);
  const schedule = scheduleId === NO_SCHEDULE ? null : (schedules.find((s) => s.id === scheduleId) ?? null);

  const preview = useMemo(() => {
    const ok = (m: number | null) => m === null || (Number.isFinite(m) && m > 0);
    if (!ok(frMin) || !ok(resMin) || (frMin === null && resMin === null)) return null;
    return previewPolicy(
      { first_response_minutes: frMin, resolution_minutes: resMin, conditions: cond },
      schedule ? toBusinessSchedule(schedule) : null,
    );
  }, [frMin, resMin, cond, schedule]);

  const when = (d: Date | null, zone: string | null) =>
    d
      ? format.dateTime(d, {
          weekday: "long",
          hour: "2-digit",
          minute: "2-digit",
          ...(zone ? { timeZone: zone } : {}),
        })
      : "";

  const save = async () => {
    const payload = {
      name,
      is_active: active,
      conditions: cond,
      first_response_minutes: frMin,
      resolution_minutes: resMin,
      schedule_id: scheduleId === NO_SCHEDULE ? null : scheduleId,
      pause_while_pending: pause,
      at_risk_percent: Number(atRisk),
    };
    if ((frMin !== null && Number.isNaN(frMin)) || (resMin !== null && Number.isNaN(resMin))) {
      setError("invalid_targets");
      return;
    }
    const checked = validatePolicyPayload(payload, false);
    if (!checked.ok) {
      setError(checked.code);
      return;
    }
    setError(null);
    setSaving(true);
    const result = policy
      ? await slaApi.updatePolicy(policy.id, checked.value)
      : await slaApi.createPolicy(checked.value);
    setSaving(false);
    if (!result.ok) {
      setError(result.code);
      return;
    }
    toast.success(t("saved"));
    onSaved();
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{policy ? t("editTitle") : t("newTitle")}</DialogTitle>
        <DialogDescription>{t("editorHint")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="sla-pol-name" className="text-foreground">
              {t("name")}
            </Label>
            <Input
              id="sla-pol-name"
              value={name}
              maxLength={80}
              placeholder={t("namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              className="bg-muted"
            />
          </div>
          <label className="flex items-center gap-2 pb-1.5 text-sm">
            <Switch checked={active} onCheckedChange={setActive} aria-label={t("active")} />
            {t("active")}
          </label>
        </div>

        <fieldset className="space-y-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold text-foreground">{t("appliesTo")}</legend>
          <p className="text-xs text-muted-foreground">{t("appliesHint")}</p>
          <ChipSelect
            label={t("priority")}
            options={TICKET_PRIORITIES.map((p) => ({ value: p, label: tPri(p) }))}
            selected={cond.priorities ?? []}
            onChange={(v) => setList("priorities", v)}
          />
          <ChipSelect
            label={t("type")}
            options={TICKET_CATEGORIES.map((c) => ({ value: c, label: tCat(c) }))}
            selected={cond.categories ?? []}
            onChange={(v) => setList("categories", v)}
          />
          <ChipSelect
            label={t("channel")}
            options={SLA_CHANNELS.map((c) => ({ value: c, label: tCh(c) }))}
            selected={cond.channels ?? []}
            onChange={(v) => setList("channels", v)}
          />
          {teams.length > 0 ? (
            <ChipSelect
              label={t("team")}
              options={teams.map((tm) => ({ value: tm.id, label: tm.name }))}
              selected={cond.team_ids ?? []}
              onChange={(v) => setList("team_ids", v)}
            />
          ) : null}
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-foreground">
              {t("labels")}
              {(cond.labels ?? []).length === 0 ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">{t("any")}</span>
              ) : (
                <span className="ml-2 text-xs font-normal text-muted-foreground">{t("labelsAny")}</span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {(cond.labels ?? []).map((l) => (
                <span key={l} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
                  {l}
                  <button
                    type="button"
                    onClick={() => setList("labels", (cond.labels ?? []).filter((x) => x !== l))}
                    aria-label={t("removeLabel", { label: l })}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <input
                list="sla-known-labels"
                value={labelInput}
                maxLength={30}
                placeholder={t("labelPlaceholder")}
                aria-label={t("labels")}
                onChange={(e) => setLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addLabel();
                  }
                }}
                onBlur={addLabel}
                className="h-7 w-40 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <datalist id="sla-known-labels">
                {knownLabels.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </div>
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <TargetField
            idPrefix="sla-fr"
            label={t("firstResponse")}
            hint={t("firstResponseHint")}
            draft={first}
            onChange={setFirst}
          />
          <TargetField
            idPrefix="sla-res"
            label={t("resolution")}
            hint={t("resolutionHint")}
            draft={resolution}
            onChange={setResolution}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sla-pol-schedule" className="text-foreground">
              {t("schedule")}
            </Label>
            <select
              id="sla-pol-schedule"
              value={scheduleId}
              onChange={(e) => setScheduleId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value={NO_SCHEDULE}>{t("allHours")}</option>
              {schedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.timezone})
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{schedules.length === 0 ? t("noSchedulesHint") : t("scheduleHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sla-pol-risk" className="text-foreground">
              {t("atRisk")}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="sla-pol-risk"
                type="number"
                min={SLA_LIMITS.atRiskMin}
                max={SLA_LIMITS.atRiskMax}
                value={atRisk}
                onChange={(e) => setAtRisk(e.target.value)}
                className="w-24 bg-muted"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            <p className="text-xs text-muted-foreground">{t("atRiskHint", { min: SLA_LIMITS.atRiskMin, max: SLA_LIMITS.atRiskMax })}</p>
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <Switch checked={pause} onCheckedChange={setPause} aria-label={t("pausePending")} className="mt-0.5" />
          <span>
            <span className="font-medium text-foreground">{t("pausePending")}</span>
            <span className="block text-xs text-muted-foreground">{t("pausePendingHint")}</span>
          </span>
        </label>

        <div className="rounded-lg border border-dashed border-border bg-muted/40 p-3" data-testid="sla-preview">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("previewTitle")}</p>
          {preview ? (
            <p className="mt-1 text-sm text-foreground">
              {preview.timezone && preview.createdLocal
                ? t("previewScheduled", {
                    priority: tPri(preview.priority),
                    created: when(preview.createdAt, preview.timezone),
                    zone: preview.timezone,
                  })
                : t("previewAllHours", { priority: tPri(preview.priority) })}{" "}
              {preview.firstResponseDue && preview.resolutionDue
                ? t("previewBoth", {
                    first: when(preview.firstResponseDue, preview.timezone),
                    resolution: when(preview.resolutionDue, preview.timezone),
                  })
                : preview.firstResponseDue
                  ? t("previewFirstOnly", { first: when(preview.firstResponseDue, preview.timezone) })
                  : t("previewResolutionOnly", { resolution: when(preview.resolutionDue, preview.timezone) })}
              {preview.startedOutsideHours ? <span className="block text-xs text-muted-foreground">{t("previewClosed")}</span> : null}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{t("previewNone")}</p>
          )}
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {tErr(error)}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {policy ? t("save") : t("create")}
        </Button>
      </DialogFooter>
    </>
  );
}
