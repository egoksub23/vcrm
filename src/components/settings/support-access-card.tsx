"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { LifeBuoy, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { useSupportAccess } from "@/hooks/use-support-access";
import { isGrantActive, SUPPORT_HOURS } from "@/lib/platform/support";

/**
 * Settings > Workspace: audited support access (migration 154). The owner can let a platform
 * operator look at diagnostics (never conversations, contacts or secrets) for a limited time, and end
 * it. Every look is listed here. Admins can read the list; only the owner can change it.
 */
export function SupportAccessCard() {
  const t = useTranslations("SupportAccess");
  const f = useFormatter();
  const { isOwner } = useAuth();
  const canSee = useCapability("settings.workspace");
  const { data, reload } = useSupportAccess(canSee);
  const [hours, setHours] = useState<number>(24);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (!canSee || !data) return null;
  const active = data.grants.filter((g) => isGrantActive(g));
  const when = (iso: string) => f.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  const allow = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/account/support-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours, reason: reason.trim() || undefined }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? t("failed"));
      toast.success(t("allowed"));
      setReason("");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(false);
    }
  };

  const end = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/account/support-access/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? t("failed"));
      toast.success(t("ended"));
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-6 border-border bg-card">
      <CardContent className="space-y-5 p-5">
        <div className="flex items-start gap-3">
          <LifeBuoy className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div>
            <h3 className="text-base font-semibold text-foreground">{t("title")}</h3>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <p className="font-medium text-foreground">{t("canSeeTitle")}</p>
          <p className="text-muted-foreground">{t("canSee")}</p>
          <p className="font-medium text-foreground">{t("cannotSeeTitle")}</p>
          <p className="text-muted-foreground">{t("cannotSee")}</p>
        </div>

        {active.length > 0 ? (
          <ul className="space-y-2">
            {active.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    <Badge variant="secondary" className="mr-2">{t("on")}</Badge>
                    {t("until", { when: when(g.expires_at) })}
                  </p>
                  {g.reason && <p className="mt-1 truncate text-xs text-muted-foreground">{g.reason}</p>}
                </div>
                {isOwner && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void end(g.id)}>
                    {t("endNow")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("off")}</p>
        )}

        {isOwner ? (
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="sa-hours">{t("duration")}</Label>
              <select
                id="sa-hours"
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              >
                {SUPPORT_HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h < 24 ? t("hours", { count: h }) : t("days", { count: h / 24 })}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sa-reason">{t("reason")}</Label>
              <Input id="sa-reason" value={reason} maxLength={500} placeholder={t("reasonPlaceholder")} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button disabled={busy} onClick={() => void allow()}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("allow")}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("ownerOnly")}</p>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{t("logTitle")}</p>
          {data.log.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("logEmpty")}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t("logWhen")}</th>
                    <th className="px-3 py-2 font-medium">{t("logWho")}</th>
                    <th className="px-3 py-2 font-medium">{t("logWhat")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.log.map((e) => (
                    <tr key={e.id} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{when(e.created_at)}</td>
                      <td className="px-3 py-2 text-foreground">{e.operator_label}</td>
                      <td className="px-3 py-2 text-foreground">{t.has(`section.${e.section}`) ? t(`section.${e.section}`) : e.section}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
