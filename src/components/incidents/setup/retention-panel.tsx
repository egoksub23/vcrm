"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import { Download, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-auth";
import { purgePhrase } from "@/lib/incidents/platform/retention";
import { api } from "./api";

interface RetentionData {
  years: number | null;
  log: { id: string; action: "export" | "purge" | "auto_purge"; cutoff: string; incident_count: number; file_count: number; created_at: string }[];
}

/** Keeping records: how long (the school's choice), and a delete tool that offers the export first and asks for the number to be typed. */
export function RetentionPanel() {
  const t = useTranslations("IncidentPlatform.retention");
  const canExport = useCapability("incidents.export");
  const [data, setData] = useState<RetentionData | null>(null);
  const [years, setYears] = useState<string>("");
  const [before, setBefore] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [exported, setExported] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<RetentionData>("/api/incidents/setup/retention");
    if (!res.ok) return;
    setData(res.data);
    setYears(res.data.years === null ? "" : String(res.data.years));
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  if (!data) return null;

  const saveYears = async () => {
    const res = await api("/api/incidents/setup/retention", "PUT", { years: years === "" ? null : Number(years) });
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("saved"));
    await load();
  };
  const check = async () => {
    setExported(false);
    setConfirm("");
    const res = await api<{ count: number }>(`/api/incidents/setup/retention/export?before=${encodeURIComponent(before)}&count=1`);
    if (!res.ok) return void toast.error(res.error);
    setCount(res.data.count);
  };
  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/incidents/setup/retention/export?before=${encodeURIComponent(before)}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Export failed");
      const truncated = res.headers.get("X-Export-Truncated") !== "0";
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `incidents-closed-before-${before}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      // A file that stopped at its limit does not hold everything that would be deleted, so it does not unlock the delete.
      setExported(!truncated);
      if (truncated) toast.error("The export is too large for one file. Choose an earlier date and delete in steps.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };
  const purge = async () => {
    setBusy(true);
    const res = await api<{ incidents: number; files: number }>("/api/incidents/setup/retention/purge", "POST", { before, confirm });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("deleted", res.data));
    setCount(null);
    setExported(false);
    setConfirm("");
    await load();
  };

  const phrase = count ? purgePhrase(count) : "";

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" aria-label={t("title")}>
      <div>
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("help")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          {t("afterYears")}
          <Input type="number" min={1} max={50} value={years} onChange={(e) => setYears(e.target.value)} placeholder="–" className="w-20" aria-label={t("afterYears")} />
          {t("years")}
        </label>
        <Button variant="outline" size="sm" onClick={() => void saveYears()}>{t("save")}</Button>
        {years === "" ? <span className="text-xs text-muted-foreground">{t("keepForever")}</span> : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">{t("deleteTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("deleteHelp")}</p>
        {canExport ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                {t("before")}
                <Input type="date" value={before} onChange={(e) => { setBefore(e.target.value); setCount(null); setExported(false); }} className="w-40" />
              </label>
              <Button variant="outline" size="sm" onClick={() => void check()} disabled={!before}>{t("check")}</Button>
            </div>
            {count !== null ? (
              <div className="flex flex-col gap-2" aria-live="polite">
                <p className="text-sm font-medium">{t("count", { count })}</p>
                {count > 0 ? (
                  <>
                    <Button variant="outline" size="sm" className="self-start" onClick={() => void download()} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Download />}{t("export")}</Button>
                    {!exported ? <p className="text-xs text-muted-foreground">{t("exportFirst")}</p> : (
                      <label className="flex flex-col gap-1 text-xs">
                        {t("typeToConfirm", { phrase })}
                        <div className="flex gap-2">
                          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="max-w-48" aria-label={t("typeToConfirm", { phrase })} />
                          <Button variant="destructive" size="sm" className="h-8" onClick={() => void purge()} disabled={busy || confirm !== phrase}><Trash2 />{t("delete")}</Button>
                        </div>
                      </label>
                    )}
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {data.log.length > 0 ? (
        <div className="border-t border-border pt-4">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("logTitle")}</h3>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {data.log.map((l) => (
              <li key={l.id}>
                {format(new Date(l.created_at), "d MMM yyyy, HH:mm")} · {t("logRow", { action: t(`log.${l.action}`), count: l.incident_count, cutoff: l.cutoff })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
