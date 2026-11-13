"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { api } from "./api";

interface Data {
  schedules: { id: string; name: string; timezone: string; is_default: boolean }[];
  schedule_id: string | null;
}

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Business hours: count the waits on timed rules (nobody acknowledged, an overdue step, still open) only inside the school's working hours. */
export function BusinessHoursPanel() {
  const t = useTranslations("IncidentPlatform.hours");
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<Data>("/api/incidents/setup/business-hours");
    if (res.ok) setData(res.data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  async function choose(value: string) {
    setBusy(true);
    const res = await api("/api/incidents/setup/business-hours", "PUT", { schedule_id: value || null });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(value ? t("on") : t("off"));
    await load();
  }

  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5" aria-label={t("title")}>
      <header>
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t("help")}</p>
      </header>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("count")}</span>
        <select className={selectClass} value={data.schedule_id ?? ""} onChange={(e) => void choose(e.target.value)} disabled={busy}>
          <option value="">{t("always")}</option>
          {data.schedules.map((s) => (
            <option key={s.id} value={s.id}>{`${s.name} (${s.timezone})`}</option>
          ))}
        </select>
      </label>
      {data.schedules.length === 0 ? <p className="text-xs text-muted-foreground">{t("none")} <Link href="/settings?tab=sla" className="text-primary hover:underline">{t("create")}</Link></p> : null}
      <p className="text-xs text-muted-foreground">{t("scope")}</p>
    </section>
  );
}
