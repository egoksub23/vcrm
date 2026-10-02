"use client";

import { useTranslations } from "next-intl";
import { LogOut, PauseCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";

/**
 * Full-screen block for a member of a workspace the platform operator has
 * suspended (migration 132). The server already refuses every API call and
 * the capability set is empty, so this is the explanation, not the lock.
 */
export function AccountSuspendedScreen() {
  const t = useTranslations("DashboardShell");
  const { platform, signOut } = useAuth();

  return (
    <div className="flex h-screen items-center justify-center bg-background px-4">
      <div role="alert" className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
          <PauseCircle className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">{t("suspendedTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("suspendedBody")}</p>
        {platform.suspendedReason && (
          <p className="mt-3 rounded-lg bg-muted p-3 text-left text-sm text-foreground">
            <span className="text-muted-foreground">{t("suspendedReason")}: </span>
            {platform.suspendedReason}
          </p>
        )}
        <Button variant="outline" className="mt-6" onClick={() => void signOut()}>
          <LogOut className="mr-2 h-4 w-4" />
          {t("signOut")}
        </Button>
      </div>
    </div>
  );
}
