"use client";

import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { WorkspaceCreateForm } from "@/components/platform/workspace-create-form";

export default function NewWorkspacePage() {
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

  return (
    <div className="p-6">
      <WorkspaceCreateForm />
    </div>
  );
}
