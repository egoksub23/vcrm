"use client";

import Link from "next/link";
import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Gauge } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAccountUsage } from "@/hooks/use-account-usage";
import { useCapability } from "@/hooks/use-can";

/**
 * A notice above every page, for the workspace's admins, while a plan limit is
 * near (80%) or reached. Renders nothing otherwise. Dismissing it hides it
 * until the page is next loaded.
 */
export function UsageBanner() {
  const t = useTranslations("Usage");
  const f = useFormatter();
  const canSee = useCapability("settings.workspace");
  const usage = useAccountUsage(canSee);
  const [dismissed, setDismissed] = useState(false);

  if (!usage || usage.state === "ok" || dismissed) return null;
  const over = usage.state === "over";
  const items = usage.meters
    .filter((m) => m.state === usage.state && m.limit !== null)
    .map((m) => t("item", { name: t(`meter.${m.key}`), used: f.number(m.used), limit: f.number(m.limit ?? 0) }))
    .join(", ");

  return (
    <Alert variant={over ? "destructive" : "default"} className="mb-4">
      <Gauge />
      <AlertTitle>{over ? t("bannerOverTitle") : t("bannerWarnTitle")}</AlertTitle>
      <AlertDescription>{over ? t("bannerOverBody", { items }) : t("bannerWarnBody", { items })}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" render={<Link href="/settings?tab=workspace" />}>
          {t("viewUsage")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          {t("dismiss")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
