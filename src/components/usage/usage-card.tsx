"use client";

import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useAccountUsage } from "@/hooks/use-account-usage";
import { useCapability } from "@/hooks/use-can";
import type { UsageMeter, UsageState } from "@/lib/platform/usage";

const BAR: Record<UsageState, string> = {
  ok: "bg-primary",
  warn: "bg-amber-500",
  over: "bg-destructive",
};

function Meter({ meter }: { meter: UsageMeter }) {
  const t = useTranslations("Usage");
  const f = useFormatter();
  const pct = meter.fraction === null ? 0 : Math.min(100, Math.round(meter.fraction * 100));
  return (
    <li className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{t(`meter.${meter.key}`)}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {meter.limit === null
            ? t("noLimit", { used: f.number(meter.used) })
            : t("usedOf", { used: f.number(meter.used), limit: f.number(meter.limit) })}
          {meter.state !== "ok" && (
            <Badge
              variant={meter.state === "over" ? "destructive" : "outline"}
              className={meter.state === "warn" ? "ml-2 border-amber-500/50 text-amber-600" : "ml-2"}
            >
              {t(meter.state === "over" ? "stateOver" : "stateWarn")}
            </Badge>
          )}
        </span>
      </div>
      {meter.limit !== null && (
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t(`meter.${meter.key}`)}
        >
          <div className={`h-full rounded-full ${BAR[meter.state]}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}

/** The workspace's usage against its plan, in Settings > Workspace (admins). */
export function UsageCard() {
  const t = useTranslations("Usage");
  const f = useFormatter();
  const canSee = useCapability("settings.workspace");
  const usage = useAccountUsage(canSee);
  if (!canSee || !usage) return null;

  return (
    <Card className="mt-6 border-border bg-card">
      <CardContent className="space-y-4 p-5">
        <div>
          <h3 className="text-base font-semibold text-foreground">{t("title")}</h3>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <ul className="space-y-4">
          {usage.meters.map((m) => (
            <Meter key={m.key} meter={m} />
          ))}
        </ul>
        {usage.storageMeasuredAt && (
          <p className="text-xs text-muted-foreground">
            {t("storageNote", { when: f.dateTime(new Date(usage.storageMeasuredAt), { dateStyle: "medium" }) })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
