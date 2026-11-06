"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Download, Loader2 } from "lucide-react";

import { NoAccess } from "@/components/auth/no-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth, useCapability } from "@/hooks/use-auth";
import { REGISTERS, referenceOf, type RegisterIncident, type RegisterKey } from "@/lib/incidents/platform/registers";
import { api } from "@/components/incidents/setup/api";

interface Data {
  rows: RegisterIncident[];
  truncated: boolean;
  categories: Record<string, string>;
  severities: Record<string, string>;
  canExport: boolean;
}

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Registers: the injury, data-breach, near-miss, property and safeguarding views of the school's incidents, with a date range and a CSV download. */
export function RegistersScreen() {
  const t = useTranslations("IncidentPlatform.registers");
  const { capabilitiesLoading } = useAuth();
  const allowed = useCapability("incidents.manage");
  const [register, setRegister] = useState<RegisterKey>("injury");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(() => {
    const p = new URLSearchParams({ register });
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p;
  }, [register, from, to]);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void api<Data>(`/api/incidents/registers?${query()}`).then((res) => {
      if (!live) return;
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [allowed, query]);

  if (capabilitiesLoading) return null;
  if (!allowed) return <NoAccess />;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          {t("register")}
          <select className={selectClass} value={register} onChange={(e) => setRegister(e.target.value as RegisterKey)}>
            {REGISTERS.map((r) => <option key={r} value={r}>{t(`names.${r}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t("from")}
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t("to")}
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </label>
        {data?.canExport ? (
          <Button variant="outline" size="sm" render={<a href={`/api/incidents/registers?${query()}&format=csv`} />}><Download />{t("download")}</Button>
        ) : null}
      </div>

      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {!data && !error ? <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} /> : null}
      {data ? (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">{t("count", { count: data.rows.length })}{data.truncated ? ` ${t("truncated")}` : ""}</p>
          {data.rows.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    {(["reference", "raised", "category", "severity", "status", "activity", "people"] as const).map((c) => <th key={c} className="px-3 py-2 font-medium">{t(`col.${c}`)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/incidents/${r.id}`} className="underline-offset-2 hover:underline">{referenceOf(r)}</Link>
                        {r.is_test ? <span className="ml-1.5 rounded bg-amber-500/20 px-1 text-[10px] font-semibold uppercase">{t("test")}</span> : null}
                      </td>
                      <td className="px-3 py-2">{r.created_at.slice(0, 10)}</td>
                      <td className="px-3 py-2">{data.categories[r.incident_type] ?? r.incident_type}</td>
                      <td className="px-3 py-2">{data.severities[r.severity] ?? r.severity}</td>
                      <td className="px-3 py-2">{r.status}</td>
                      <td className="px-3 py-2">{r.activity?.name ?? ""}</td>
                      <td className="px-3 py-2">{r.involved_count ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
