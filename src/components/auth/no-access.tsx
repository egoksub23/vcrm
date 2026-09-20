"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Lock } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { firstAccessiblePage } from "@/lib/auth/page-access";

interface NoAccessProps {
  /** Override the "go somewhere else" link (defaults to the first menu
   *  item the person still holds). */
  href?: string;
  linkLabel?: string;
}

/**
 * Friendly "you do not have access to this page" state. Not an error
 * and never a redirect: the person stays where they are, is told what
 * happened and is offered a page they can use. If the permission set
 * is empty (the capabilities could not be loaded at all) a "check
 * again" button re-reads it.
 */
export function NoAccess({ href, linkLabel }: NoAccessProps) {
  const t = useTranslations("Permissions.access");
  const tNav = useTranslations("Sidebar");
  const { capabilities, refreshCapabilities } = useAuth();
  const [checking, setChecking] = useState(false);

  const target = firstAccessiblePage((cap) => capabilities.has(cap));
  const linkHref = href ?? target?.prefix ?? null;
  const label =
    linkLabel ?? (target ? t("goTo", { page: tNav(target.labelKey) }) : "");
  // An empty set most likely means the load failed: a real role always
  // holds something unless every capability was switched off.
  const looksLikeLoadFailure = capabilities.size === 0;

  const recheck = async () => {
    setChecking(true);
    try {
      await refreshCapabilities();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      role="status"
      className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock className="size-5" />
      </div>
      <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
      <p className="text-sm text-muted-foreground">
        {looksLikeLoadFailure ? t("descriptionUnknown") : t("description")}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {linkHref && label ? (
          <Link
            href={linkHref}
            className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {label}
          </Link>
        ) : null}
        {looksLikeLoadFailure ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={recheck}
            disabled={checking}
          >
            {checking ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("recheck")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
