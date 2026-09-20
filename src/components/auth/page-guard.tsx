"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { NoAccess } from "@/components/auth/no-access";
import { capabilityForPath } from "@/lib/auth/page-access";

/**
 * Guards a dashboard page by the menu capability its path maps to
 * (deep links included). Fails closed and never flashes the wrong
 * thing:
 *   - not a guarded path                  -> children
 *   - capabilities loading                -> a small loading state
 *   - capability held                     -> children
 *   - capability missing / load failed    -> NoAccess
 */
export function PageGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { capabilities, capabilitiesLoading, accountRole } = useAuth();
  const t = useTranslations("DashboardShell");

  const required = capabilityForPath(pathname);
  if (!required) return <>{children}</>;

  if (capabilitiesLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!accountRole || !capabilities.has(required)) return <NoAccess />;
  return <>{children}</>;
}
