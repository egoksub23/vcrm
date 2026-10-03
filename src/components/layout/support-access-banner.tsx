"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { LifeBuoy } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { useSupportAccess } from "@/hooks/use-support-access";
import { isGrantActive } from "@/lib/platform/support";

/** Above every page, for the workspace's admins, while support access is on (migration 154). */
export function SupportAccessBanner() {
  const t = useTranslations("SupportAccess");
  const f = useFormatter();
  const canSee = useCapability("settings.workspace");
  const { data } = useSupportAccess(canSee);
  const active = data?.grants.filter((g) => isGrantActive(g)) ?? [];
  if (active.length === 0) return null;
  const until = active.reduce((a, g) => (new Date(g.expires_at) > new Date(a) ? g.expires_at : a), active[0].expires_at);

  return (
    <Alert className="mb-4">
      <LifeBuoy />
      <AlertTitle>{t("bannerTitle")}</AlertTitle>
      <AlertDescription>{t("bannerBody", { when: f.dateTime(new Date(until), { dateStyle: "medium", timeStyle: "short" }) })}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" render={<Link href="/settings?tab=workspace" />}>
          {t("bannerAction")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
