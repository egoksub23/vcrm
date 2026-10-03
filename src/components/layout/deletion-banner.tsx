"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";

/** Above every page while the workspace is scheduled for deletion (migration 153), for every member. */
export function DeletionBanner() {
  const t = useTranslations("DataControl");
  const f = useFormatter();
  const { platform, isOwner } = useAuth();
  if (!platform.deletionDueAt) return null;
  const date = f.dateTime(new Date(platform.deletionDueAt), { dateStyle: "long" });

  return (
    <Alert variant="destructive" className="mb-4">
      <Trash2 />
      <AlertTitle>{t("bannerTitle")}</AlertTitle>
      <AlertDescription>{isOwner ? t("bannerBodyOwner", { date }) : t("bannerBody", { date })}</AlertDescription>
      {isOwner && (
        <AlertAction>
          <Button size="sm" variant="outline" render={<Link href="/settings?tab=workspace" />}>
            {t("openSettings")}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
