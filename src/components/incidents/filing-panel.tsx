"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { Download, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/components/incidents/setup/api";
import { InfoTip } from "./info-tip";

interface Report {
  id: string;
  version: number;
  filename: string;
  size_bytes: number;
  generated_at: string;
  generated_by_name?: string | null;
}

/**
 * On a closed incident: make the report for filing (a PDF of everything recorded from the report to the closure), and download the ones already made.
 * Each one is kept with the incident. Shown to people who hold incidents.export.
 */
export function FilingPanel({ incidentId, onChanged }: { incidentId: string; onChanged?: () => void }) {
  const t = useTranslations("IncidentPlatform.filing");
  const tTips = useTranslations("Incidents.detail.tips");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(async () => {
    const res = await api<{ reports: Report[] }>(`/api/incidents/${incidentId}/filed-reports`);
    if (res.ok) setReports(res.data.reports);
    else setReports([]);
  }, [incidentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    setBusy(true);
    setWarnings([]);
    let timeZone = "UTC";
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      /* keep UTC */
    }
    const res = await api<{ report: Report; unsupportedCharacters: number; picturesNotShown: number }>(`/api/incidents/${incidentId}/filed-reports`, "POST", { timeZone });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(t("made", { version: res.data.report.version }));
    const w: string[] = [];
    if (res.data.unsupportedCharacters > 0) w.push(t("charsWarn", { count: res.data.unsupportedCharacters }));
    if (res.data.picturesNotShown > 0) w.push(t("picturesWarn", { count: res.data.picturesNotShown }));
    setWarnings(w);
    await load();
    onChanged?.();
  }

  const has = (reports?.length ?? 0) > 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <FileText className="size-3.5" />
        {t("title")}
        <InfoTip text={tTips("filing")} />
      </h3>
      <p className="text-xs text-muted-foreground">{t("help")}</p>

      {reports === null ? <Loader2 className="mt-3 size-4 animate-spin text-muted-foreground" aria-label={t("loading")} /> : null}
      {reports && !has ? <p className="mt-3 text-xs text-muted-foreground">{t("none")}</p> : null}
      {reports && has ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {reports.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{t("version", { version: r.version })}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {format(new Date(r.generated_at), "d MMM yyyy, HH:mm")}
                  {r.generated_by_name ? `, ${r.generated_by_name}` : ""} · {Math.max(1, Math.round(r.size_bytes / 1024))} KB
                </span>
              </span>
              <Button variant="outline" size="sm" render={<a href={`/api/incidents/${incidentId}/filed-reports/${r.id}`} download />}>
                <Download />
                {t("download")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {warnings.map((w) => (
        <p key={w} role="status" className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{w}</p>
      ))}

      <Button size="sm" className="mt-3" onClick={() => void generate()} disabled={busy || reports === null}>
        {busy ? <Loader2 className="animate-spin" /> : <FileText />}
        {busy ? t("generating") : has ? t("generateAgain") : t("generate")}
      </Button>
      {has ? <p className="mt-2 text-[11px] text-muted-foreground">{t("keepNote")}</p> : null}
    </div>
  );
}
