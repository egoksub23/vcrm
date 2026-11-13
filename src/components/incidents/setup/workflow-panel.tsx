"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Guard, Requires } from "@/lib/incidents/platform/workflow";
import { api } from "./api";

interface WorkflowData {
  guards: Guard[];
  allowBackward: boolean;
  roles: { key: string; name: string }[];
  statuses: { key: string; label: string }[];
}

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Before an incident moves on: what must be true for each status. Nothing ticked means the status can be reached freely, as it always could. */
export function WorkflowPanel() {
  const t = useTranslations("IncidentPlatform.workflow");
  const [data, setData] = useState<WorkflowData | null>(null);
  const [guards, setGuards] = useState<Record<string, Requires>>({});
  const [allowBackward, setAllowBackward] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<WorkflowData>("/api/incidents/setup/workflow");
    if (!res.ok) return;
    setData(res.data);
    setGuards(Object.fromEntries(res.data.guards.map((g) => [g.to_status, g.requires])));
    setAllowBackward(res.data.allowBackward);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  if (!data) return null;

  const set = (status: string, patch: Partial<Requires>) => setGuards((cur) => ({ ...cur, [status]: { ...cur[status], ...patch } }));

  const save = async () => {
    setBusy(true);
    const res = await api("/api/incidents/setup/workflow", "PUT", {
      allow_backward: allowBackward,
      guards: Object.entries(guards).map(([to_status, requires]) => ({ to_status, requires })),
    });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("saved"));
    await load();
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label={t("title")}>
      <div>
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("help")}</p>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {data.statuses.map((s) => {
          const r = guards[s.key] ?? {};
          return (
            <li key={s.key} className="flex flex-col gap-1.5 py-3">
              <p className="text-sm font-medium">{t("before", { status: s.label })}</p>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(r.root_cause)} onChange={(e) => set(s.key, { root_cause: e.target.checked })} />{t("rootCause")}</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(r.steps_done)} onChange={(e) => set(s.key, { steps_done: e.target.checked })} />{t("stepsDone")}</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(r.lead_assigned)} onChange={(e) => set(s.key, { lead_assigned: e.target.checked })} />{t("leadAssigned")}</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(r.closing_note)} onChange={(e) => set(s.key, { closing_note: e.target.checked })} />{t("closingNote")}</label>
                <label className="flex items-center gap-1.5">
                  {t("approvedBy")}
                  <select className={selectClass} value={r.approval_role ?? ""} onChange={(e) => set(s.key, { approval_role: e.target.value || null })} aria-label={t("approvedBy")}>
                    <option value="">{t("nobody")}</option>
                    {data.roles.map((role) => <option key={role.key} value={role.key}>{role.name}</option>)}
                  </select>
                </label>
              </div>
            </li>
          );
        })}
      </ul>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={allowBackward} onChange={(e) => setAllowBackward(e.target.checked)} />
        {t("allowBackward")}
      </label>
      <div>
        <Button size="sm" onClick={() => void save()} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{t("save")}</Button>
      </div>
    </section>
  );
}
