"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "./api";

export interface PortalSchool {
  group_id: string;
  group_name: string;
  allowed_origins: string[];
  enabled: boolean;
}
interface PortalData {
  schools: PortalSchool[];
  calls: { id: string; route: string; status: number; summary: string | null; created_at: string }[];
  address: string | null;
  retentionYears: number | null;
  canTest: boolean;
}

/** One school's link to the coach portal, as the Halo operator set it up. */
export function SchoolLink({ s }: { s: PortalSchool }) {
  const t = useTranslations("IncidentPlatform.portal");
  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", s.enabled ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/20 text-amber-800 dark:text-amber-300")}>{s.enabled ? t("on") : t("off")}</span>
        <span className="text-sm font-medium">{s.group_name}</span>
        <span className="font-mono text-xs text-muted-foreground">{t("groupId")}: {s.group_id}</span>
      </div>
      <p className="mt-3 text-xs font-medium">{t("allowed")}</p>
      {s.allowed_origins.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
          {s.allowed_origins.map((o) => <li key={o}>{o}</li>)}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t("noOrigins")}</p>
      )}
    </li>
  );
}

/** Coach portal: which Vircle Group is linked to this school and where its report page may be shown (set by the Halo operator), a test report, and the call log. */
export function PortalScreen() {
  const t = useTranslations("IncidentPlatform.portal");
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<PortalData>("/api/incidents/setup/portal");
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

  const sendTest = async () => {
    setBusy(true);
    const res = await api<{ url: string }>("/api/incidents/setup/portal/test-report", "POST");
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setTest(res.data.url);
  };
  const linked = data.schools.some((s) => s.enabled);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("linkTitle")}</h2>
        {data.schools.length === 0 ? <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{t("notLinked")}</p> : null}
        <ul className="flex flex-col gap-3">
          {data.schools.map((s) => <SchoolLink key={s.group_id} s={s} />)}
        </ul>
        <p className="text-xs text-muted-foreground">{t("managedBy")}</p>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t("testTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("testHelp")}</p>
        {!data.address ? <p role="alert" className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{t("addressNotSet")}</p> : null}
        {linked && !data.canTest ? <p className="mt-2 text-xs text-muted-foreground">{t("noTestKey")}</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={busy || !linked || !data.canTest || !data.address}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("testButton")}
          </Button>
          {test ? (
            <a href={test} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary underline">
              <ExternalLink className="size-3.5" />
              {t("testOpen")}
            </a>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t("callsTitle")}</h2>
        {data.calls.length === 0 ? <p className="text-sm text-muted-foreground">{t("noCalls")}</p> : null}
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
          {data.calls.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-xs">
              <span className={cn("w-9 shrink-0 font-mono font-semibold", c.status >= 400 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>{c.status}</span>
              <span className="w-28 shrink-0 font-mono">{c.route}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.summary}</span>
              <span className="shrink-0 text-muted-foreground">{formatDistanceToNowStrict(new Date(c.created_at))}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
