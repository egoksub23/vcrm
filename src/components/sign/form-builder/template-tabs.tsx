"use client";

// The two views of one template: where fields sit on the page, and the form a signer fills in. A link in each
// screen's header, the current one marked. `onNavigate` lets the screen ask first when it has unsaved changes.

import Link from "next/link";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export function TemplateTabs({ templateId, current, onNavigate, className, formOnly }: { templateId: string; current: "layout" | "form"; onNavigate: (href: string) => void; className?: string; /** A form without a signature has no page to place fields on: one view, so no tabs. */ formOnly?: boolean }) {
  const t = useTranslations("Sign.formBuilder");
  if (formOnly) return null;
  const tabs = [
    { key: "layout", href: `/sign/templates/${templateId}`, label: t("tabs.layout") },
    { key: "form", href: `/sign/templates/${templateId}/form`, label: t("tabs.form") },
  ] as const;
  return (
    <nav aria-label={t("tabs.label")} className={cn("inline-flex h-8 items-center rounded-lg bg-muted p-[3px] text-sm", className)}>
      {tabs.map((tab) => {
        const on = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={on ? "page" : undefined}
            onClick={(e) => {
              if (on || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onNavigate(tab.href);
            }}
            className={cn("inline-flex h-full items-center rounded-md px-3 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
