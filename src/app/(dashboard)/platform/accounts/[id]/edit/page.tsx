"use client";

import { use } from "react";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { WorkspaceEditForm } from "@/components/platform/workspace-edit-form";

export default function EditWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const t = useTranslations("Platform");
  const { isPlatformAdmin, profileLoading } = useAuth();
  const { id } = use(params);

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
      <WorkspaceEditForm id={id} />
    </div>
  );
}
