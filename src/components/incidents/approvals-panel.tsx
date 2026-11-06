"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import { Check, Loader2, Stamp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api } from "@/components/incidents/setup/api";

interface ApprovalRow {
  id: string;
  role_key: string;
  role_name: string;
  for_status: string | null;
  requested_at: string;
  decision: "approved" | "rejected" | null;
  decided_at: string | null;
  note: string | null;
}

/** Approvals on an incident: who was asked, and (for the person who holds the role) the buttons to answer. Shown only when someone was asked. */
export function ApprovalsPanel({ incidentId, onAnswered }: { incidentId: string; onAnswered?: () => void }) {
  const t = useTranslations("IncidentPlatform.approvals");
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [canDecide, setCanDecide] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ approvals: ApprovalRow[]; canDecide: string[] }>(`/api/incidents/${incidentId}/approvals`);
    if (res.ok) {
      setRows(res.data.approvals);
      setCanDecide(res.data.canDecide);
    }
  }, [incidentId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  if (!rows || rows.length === 0) return null;

  const answer = async (decision: "approved" | "rejected") => {
    setBusy(decision);
    const res = await api(`/api/incidents/${incidentId}/approvals`, "POST", { decision, note });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setNote("");
    await load();
    onAnswered?.();
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Stamp className="size-3.5" />
        {t("title")}
      </h3>
      <ul className="flex flex-col gap-2 text-xs">
        {rows.map((a) => (
          <li key={a.id} className="flex items-start gap-2">
            <span className={cn("mt-0.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium", a.decision === "approved" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : a.decision === "rejected" ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-amber-500/20 text-amber-800 dark:text-amber-300")}>
              {a.decision ? t(`decision.${a.decision}`) : t("waiting")}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{a.role_name}</span>
              {a.for_status ? <span className="text-muted-foreground"> · {t("forStatus", { status: a.for_status })}</span> : null}
              <span className="block text-[10.5px] text-muted-foreground">{format(new Date(a.decided_at ?? a.requested_at), "d MMM, HH:mm")}</span>
              {a.note ? <span className="block text-muted-foreground">{a.note}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {canDecide.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs font-medium">{t("yourAnswer")}</p>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t("notePlaceholder")} aria-label={t("note")} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void answer("approved")} disabled={busy !== null}>{busy === "approved" ? <Loader2 className="animate-spin" /> : <Check />}{t("approve")}</Button>
            <Button size="sm" variant="outline" onClick={() => void answer("rejected")} disabled={busy !== null || !note.trim()}>{busy === "rejected" ? <Loader2 className="animate-spin" /> : <X />}{t("reject")}</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("rejectNeedsReason")}</p>
        </div>
      ) : null}
    </div>
  );
}
