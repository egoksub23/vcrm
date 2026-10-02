"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { EncryptionReport, ReencryptResult } from "@/lib/crypto/reencrypt";

/**
 * Platform console: which key the stored secrets (channel tokens, API keys,
 * webhook secrets) are encrypted under, and a one-click re-encrypt after a key
 * rotation. Counts and key ids only; never a key or a stored value.
 */
export function EncryptionCard() {
  const t = useTranslations("Platform");
  const [report, setReport] = useState<EncryptionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ReencryptResult | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/platform/encryption", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (EncryptionReport & { error?: string }) | null;
      if (!res.ok || !body) {
        setError(body?.error ?? t("encLoadFailed"));
        return;
      }
      setReport(body);
      setError(null);
    } catch {
      setError(t("encLoadFailed"));
    }
  }, [t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void load();
  }, [load]);

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/platform/encryption", { method: "POST" });
      const body = (await res.json().catch(() => null)) as (ReencryptResult & { error?: string }) | null;
      if (!res.ok || !body) {
        toast.error(body?.error ?? t("encRunFailed"));
        return;
      }
      setLast(body);
      toast.success(t("encRan", { count: body.rewritten }));
      await load();
    } catch {
      toast.error(t("encRunFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (error && !report) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="p-4">
          <p className="text-sm font-medium text-foreground">{t("encTitle")}</p>
          <p className="text-sm text-destructive">{error}</p>
        </CardContent>
      </Card>
    );
  }
  if (!report) return null;

  // Stored values per key, summed over every column.
  const perKey = new Map<string, number>();
  let unrecognised = 0;
  for (const c of report.columns) {
    unrecognised += c.unrecognised;
    for (const [id, n] of Object.entries(c.byKey)) perKey.set(id, (perKey.get(id) ?? 0) + n);
  }

  return (
    <Card className="border-border bg-card">
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="text-sm font-medium text-foreground">{t("encTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("encDesc")}</p>
        </div>

        <p className="text-sm text-foreground">
          {report.versioned ? t("encWritingWith", { id: report.currentKeyId }) : t("encNotRotating")}
        </p>

        <ul className="flex flex-wrap gap-2">
          {[...perKey.entries()].map(([id, n]) => (
            <li key={id}>
              <Badge variant={id === report.currentKeyId ? "secondary" : "outline"}>
                {id === "legacy" ? t("encKeyLegacy") : id === "legacy-cbc" ? t("encKeyCbc") : id}: {n}
              </Badge>
            </li>
          ))}
          {unrecognised > 0 && (
            <li>
              <Badge variant="outline">{t("encUnrecognised", { count: unrecognised })}</Badge>
            </li>
          )}
        </ul>

        <div className="flex flex-wrap items-center gap-3">
          {report.stale > 0 ? (
            <>
              <p className="text-sm text-foreground">{t("encStale", { count: report.stale })}</p>
              <Button size="sm" disabled={busy} onClick={() => void run()}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("encReencrypt")}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("encAllCurrent")}</p>
          )}
        </div>

        {last && (
          <p className="text-xs text-muted-foreground">
            {t("encLastRun", { rewritten: last.rewritten, conflicts: last.conflicts, unreadable: last.unreadable })}
            {!last.finished && ` ${t("encNotFinished")}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
