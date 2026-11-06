"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import { Check, Loader2, Mail, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/components/incidents/setup/api";

export interface DeliveryRow {
  id: string;
  role_key: string;
  recipient_name: string;
  channel: string;
  address: string;
  reason: string;
  ask_ack: boolean;
  status: "queued" | "sending" | "sent" | "failed" | "skipped" | "acknowledged";
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  acknowledged_at: string | null;
  is_test: boolean;
  created_at: string;
}

/** "head_of_sport" -> "Head of sport": a readable fallback when the role's own name is not at hand. */
export function roleLabel(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TONE: Record<DeliveryRow["status"], string> = {
  queued: "bg-muted text-muted-foreground",
  sending: "bg-muted text-muted-foreground",
  sent: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  acknowledged: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  skipped: "bg-muted text-muted-foreground",
};

/** The message log for one incident: who was told, how, and whether it arrived or was acknowledged. A failed message can be retried. */
export function MessageLogPanel({ incidentId, canManage }: { incidentId: string; canManage: boolean }) {
  const t = useTranslations("IncidentPlatform.log");
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ deliveries: DeliveryRow[] }>(`/api/incidents/${incidentId}/deliveries`);
    if (res.ok) setRows(res.data.deliveries);
  }, [incidentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  if (rows === null) return null;
  if (rows.length === 0) return null;

  const retry = async (row: DeliveryRow) => {
    setBusy(row.id);
    const res = await api(`/api/incidents/${incidentId}/deliveries/${row.id}`, "POST");
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    await load();
  };
  const acknowledge = async () => {
    setBusy("ack");
    const res = await api(`/api/incidents/${incidentId}/acknowledge`, "POST");
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    await load();
  };

  const waiting = rows.some((r) => r.ask_ack && !r.acknowledged_at && !r.is_test);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Mail className="size-3.5" />
        {t("title")}
        <span className="ml-auto font-medium normal-case">{rows.length}</span>
      </h3>
      {waiting && canManage ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">{t("waiting")}</span>
          <Button size="sm" onClick={() => void acknowledge()} disabled={busy === "ack"}>
            {busy === "ack" ? <Loader2 className="animate-spin" /> : <Check />}
            {t("acknowledge")}
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <li key={r.id} className="text-xs">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {roleLabel(r.role_key)}
                {r.is_test ? <span className="ml-1.5 rounded bg-amber-500/20 px-1 text-[10px] font-semibold uppercase">{t("test")}</span> : null}
              </span>
              <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium", TONE[r.status])}>{t(`status.${r.status}`)}</span>
            </div>
            <p className="truncate text-muted-foreground">
              {r.recipient_name} · {r.address}
            </p>
            <p className="text-[10.5px] text-muted-foreground">
              {t(`reason.${r.reason}`)} · {format(new Date(r.acknowledged_at ?? r.sent_at ?? r.created_at), "d MMM, HH:mm")}
            </p>
            {r.status === "failed" ? (
              <p className="mt-0.5 flex items-start gap-2 text-red-600 dark:text-red-400">
                <span className="min-w-0 flex-1">{r.last_error ?? t("failedUnknown")}</span>
                {canManage ? (
                  <Button variant="outline" size="xs" onClick={() => void retry(r)} disabled={busy === r.id}>
                    {busy === r.id ? <Loader2 className="animate-spin" /> : <RotateCw />}
                    {t("retry")}
                  </Button>
                ) : null}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
