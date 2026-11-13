"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { NoAccess } from "@/components/auth/no-access";
import { Button } from "@/components/ui/button";
import { useAuth, useCapability } from "@/hooks/use-auth";
import { describeNotBefore } from "@/lib/incidents/platform/clearance";
import { api } from "@/components/incidents/setup/api";

interface Row {
  id: string;
  external_student_id: string;
  student_name: string;
  type: string;
  not_before: string;
  incident_id: string | null;
  incident_reference: string | null;
}

/** Return to play: the dates the nurse has set. The coach portal shows each as a warning; nothing here stops a student from doing anything. */
export function ClearancesScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useTranslations("IncidentPlatform.clearances");
  const { capabilitiesLoading } = useAuth();
  const allowed = useCapability("incidents.medical");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ clearances: Row[] }>("/api/incidents/clearances");
    if (res.ok) {
      setRows(res.data.clearances);
      setError(null);
    } else setError(res.error);
  }, []);
  useEffect(() => {
    if (!allowed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [allowed, load]);

  if (capabilitiesLoading) return null;
  if (!allowed) return <NoAccess />;

  const clear = async (row: Row) => {
    const res = await api(`/api/incidents/clearances/${row.id}`, "DELETE");
    if (!res.ok) return void toast.error(res.error);
    await load();
  };

  return (
    <div className={embedded ? "flex flex-col gap-4" : "mx-auto flex max-w-[1100px] flex-col gap-4"}>
      {embedded ? (
        <p className="max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
      ) : (
        <header>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
        </header>
      )}
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {!rows && !error ? <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} /> : null}
      {rows && rows.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{t("empty")}</p> : null}
      {rows && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t("student")}</th>
                <th className="px-4 py-2 font-medium">{t("type")}</th>
                <th className="px-4 py-2 font-medium">{t("notBefore")}</th>
                <th className="px-4 py-2 font-medium">{t("incident")}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-medium">{r.student_name}</td>
                  <td className="px-4 py-2.5">{t(`type_${r.type}`)}</td>
                  <td className="px-4 py-2.5">{describeNotBefore(r.not_before).replace("not before ", "")}</td>
                  <td className="px-4 py-2.5">{r.incident_id ? <Link href={`/incidents/${r.incident_id}`} className="font-mono text-xs underline-offset-2 hover:underline">{r.incident_reference}</Link> : null}</td>
                  <td className="px-4 py-2.5 text-right"><Button variant="ghost" size="sm" onClick={() => void clear(r)}>{t("clearNow")}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
