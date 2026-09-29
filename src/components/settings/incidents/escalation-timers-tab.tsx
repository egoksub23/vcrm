"use client";

// Settings > Incidents > Escalation timers (incidents.manage). One row
// per severity (P1-P4, fixed — incident_escalation_policies is keyed
// (account_id, severity), not a reorderable list like ticket SLA
// policies). Each row: a business-hours schedule (reused as-is from
// Settings > SLA & business hours — no second schedule system) plus
// level-1/level-2 minute targets. "Reset to default" deletes the
// override row, falling back to incident_escalation_default_minutes()
// and 24/7 (migration 122).

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { ESCALATION_DEFAULT_MINUTES } from "@/lib/incidents/constants";

const SEVERITIES = ["P1", "P2", "P3", "P4"] as const;
type Severity = (typeof SEVERITIES)[number];

interface ScheduleOption {
  id: string;
  name: string;
  timezone: string;
}

interface PolicyRow {
  severity: Severity;
  level_1_minutes: number;
  level_2_minutes: number;
  schedule_id: string | null;
}

const NO_SCHEDULE = "__24_7__";

export function EscalationTimersTab() {
  const t = useTranslations("Settings.incidents.timers");
  const [schedules, setSchedules] = useState<ScheduleOption[]>([]);
  const [policies, setPolicies] = useState<Record<Severity, PolicyRow | null>>({
    P1: null,
    P2: null,
    P3: null,
    P4: null,
  });
  const [loading, setLoading] = useState(true);
  const [savingSeverity, setSavingSeverity] = useState<Severity | null>(null);

  const load = async () => {
    setLoading(true);
    const supabase = createClient();
    const [{ data: sch }, { data: pol }] = await Promise.all([
      supabase.from("business_hours_schedules").select("id, name, timezone").order("name"),
      supabase.from("incident_escalation_policies").select("*"),
    ]);
    setSchedules((sch as ScheduleOption[]) ?? []);
    const bySeverity: Record<Severity, PolicyRow | null> = { P1: null, P2: null, P3: null, P4: null };
    for (const row of (pol as PolicyRow[]) ?? []) bySeverity[row.severity] = row;
    setPolicies(bySeverity);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (severity: Severity, level1: number, level2: number, scheduleId: string | null) => {
    setSavingSeverity(severity);
    try {
      const res = await fetch(`/api/account/incidents/escalation-policies/${severity}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level_1_minutes: level1, level_2_minutes: level2, schedule_id: scheduleId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("saveFailed"));
        return;
      }
      setPolicies((prev) => ({ ...prev, [severity]: data.policy }));
      toast.success(t("saved"));
    } finally {
      setSavingSeverity(null);
    }
  };

  const reset = async (severity: Severity) => {
    setSavingSeverity(severity);
    try {
      const res = await fetch(`/api/account/incidents/escalation-policies/${severity}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || t("resetFailed"));
        return;
      }
      setPolicies((prev) => ({ ...prev, [severity]: null }));
      toast.success(t("reset"));
    } finally {
      setSavingSeverity(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {SEVERITIES.map((severity) => (
        <SeverityRow
          key={severity}
          severity={severity}
          policy={policies[severity]}
          schedules={schedules}
          saving={savingSeverity === severity}
          onSave={(l1, l2, sid) => void save(severity, l1, l2, sid)}
          onReset={() => void reset(severity)}
        />
      ))}
    </div>
  );
}

function SeverityRow({
  severity,
  policy,
  schedules,
  saving,
  onSave,
  onReset,
}: {
  severity: Severity;
  policy: PolicyRow | null;
  schedules: ScheduleOption[];
  saving: boolean;
  onSave: (level1: number, level2: number, scheduleId: string | null) => void;
  onReset: () => void;
}) {
  const t = useTranslations("Settings.incidents.timers");
  const defaults = ESCALATION_DEFAULT_MINUTES[severity];
  const [level1, setLevel1] = useState(String(policy?.level_1_minutes ?? defaults.level1));
  const [level2, setLevel2] = useState(String(policy?.level_2_minutes ?? defaults.level2));
  const [scheduleId, setScheduleId] = useState(policy?.schedule_id ?? NO_SCHEDULE);

  useEffect(() => {
    setLevel1(String(policy?.level_1_minutes ?? defaults.level1));
    setLevel2(String(policy?.level_2_minutes ?? defaults.level2));
    setScheduleId(policy?.schedule_id ?? NO_SCHEDULE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy]);

  const dirty =
    Number(level1) !== (policy?.level_1_minutes ?? defaults.level1) ||
    Number(level2) !== (policy?.level_2_minutes ?? defaults.level2) ||
    scheduleId !== (policy?.schedule_id ?? NO_SCHEDULE);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-16">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("severity")}</p>
          <p className="mt-1 text-sm font-medium text-foreground">{severity}</p>
        </div>
        <div>
          <label className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("level1Minutes")}</label>
          <Input
            type="number"
            min={1}
            max={525600}
            value={level1}
            onChange={(e) => setLevel1(e.target.value)}
            className="mt-1 h-8 w-28 text-xs"
          />
        </div>
        <div>
          <label className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("level2Minutes")}</label>
          <Input
            type="number"
            min={1}
            max={525600}
            value={level2}
            onChange={(e) => setLevel2(e.target.value)}
            className="mt-1 h-8 w-28 text-xs"
          />
        </div>
        <div className="min-w-48 flex-1">
          <label className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("schedule")}</label>
          <select
            value={scheduleId}
            onChange={(e) => setScheduleId(e.target.value)}
            className="mt-1 h-8 w-full rounded-md border border-input bg-muted px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value={NO_SCHEDULE}>{t("allHours")}</option>
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.timezone})
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-8"
            disabled={!dirty || saving || !level1.trim() || !level2.trim()}
            onClick={() => onSave(Number(level1), Number(level2), scheduleId === NO_SCHEDULE ? null : scheduleId)}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("save")}
          </Button>
          {policy && (
            <Button variant="ghost" size="icon-sm" title={t("resetToDefault")} aria-label={t("resetToDefault")} onClick={onReset} disabled={saving}>
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      {!policy && <p className="mt-2 text-[11px] text-muted-foreground">{t("usingDefault", { level1: defaults.level1, level2: defaults.level2 })}</p>}
    </div>
  );
}
