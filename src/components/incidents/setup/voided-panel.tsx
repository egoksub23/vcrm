"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { incidentKey, type Incident } from "@/lib/incidents/types";
import { api } from "./api";

/**
 * Voided incidents (raised by mistake): they are out of the Dashboard and Reports but stay on record. Anyone who manages incidents can restore one; only the
 * school's Owner can delete one for good, by typing its reference.
 */
export function VoidedPanel() {
  const t = useTranslations("IncidentPlatform.voided");
  const { accountRole } = useAuth();
  const isOwner = accountRole === "owner";
  const [rows, setRows] = useState<Incident[] | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ incidents: Incident[] }>("/api/incidents?voided=1");
    setRows(res.ok ? res.data.incidents : []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  async function restore(id: string) {
    setBusy(true);
    const res = await api(`/api/incidents/${id}/void`, "DELETE");
    setBusy(false);
    if (!res.ok) toast.error(res.error);
    else {
      toast.success(t("restored"));
      await load();
    }
  }

  async function remove(id: string) {
    setBusy(true);
    const res = await api(`/api/incidents/${id}`, "DELETE", { confirm: typed });
    setBusy(false);
    if (!res.ok) toast.error(res.error);
    else {
      toast.success(t("deleted"));
      setConfirmFor(null);
      setTyped("");
      await load();
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <header>
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t("help")}</p>
      </header>
      {rows === null ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t("loading")} /> : null}
      {rows && rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : null}
      <ul className="flex flex-col gap-2">
        {(rows ?? []).map((r) => (
          <li key={r.id} className="rounded-lg border border-border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{incidentKey(r)}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
              {r.voided_at ? <span className="text-xs text-muted-foreground">{format(new Date(r.voided_at), "d MMM yyyy")}</span> : null}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore(r.id)}>{t("restore")}</Button>
              {isOwner ? <Button variant="outline" size="sm" disabled={busy} className="text-destructive" onClick={() => { setConfirmFor(confirmFor === r.id ? null : r.id); setTyped(""); }}>{t("delete")}</Button> : null}
            </div>
            {r.void_reason ? <p className="mt-1 text-xs text-muted-foreground">{t("reason")} {r.void_reason}</p> : null}
            {confirmFor === r.id ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={incidentKey(r)} aria-label={t("typeRef")} className="h-8 w-48" />
                <Button size="sm" disabled={busy || typed.trim() !== incidentKey(r)} className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void remove(r.id)}>{t("deleteConfirm")}</Button>
                <span className="text-xs text-muted-foreground">{t("deleteNote")}</span>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
