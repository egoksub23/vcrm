"use client";

import { useTranslations } from "next-intl";

import { PlatformConsole } from "@/components/platform/platform-console";
import { useAuth } from "@/hooks/use-auth";

// Operator console. Not a capability-gated menu: platform admins are a
// separate population from account roles (migration 132), so the page
// checks `isPlatformAdmin` itself. This is only the UI gate; every
// /api/platform route and the platform_* RPCs re-check it on the server.
export default function PlatformPage() {
  const t = useTranslations("Platform");
  const { isPlatformAdmin, profileLoading } = useAuth();

  if (profileLoading) return null;
  if (!isPlatformAdmin) {
    return (
      <div role="alert" className="mx-auto max-w-md rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {t("notAllowed")}
      </div>
    );
  }
  return <PlatformConsole />;
}
