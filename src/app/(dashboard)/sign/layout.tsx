"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileSignature, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { NoAccess } from "@/components/auth/no-access";
import { buttonVariants } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/sign", labelKey: "tabDocuments" },
  { href: "/sign/templates", labelKey: "tabTemplates" },
] as const;

/**
 * The Doc Sign section: a title, the two tabs (Documents, Templates) and the "New document" button above the two
 * list screens. Every other screen in the section (a document, the new-document steps, the template editor)
 * takes the whole page without this strip. The dashboard's page guard already stops people without
 * `menu.sign`; the check here only keeps this strip honest if that mapping ever changes.
 */
export default function SignLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("Sign.send.shell");
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  const canView = useCapability("menu.sign");
  const canSend = useCapability("sign.send");

  const onList = pathname === "/sign" || pathname === "/sign/templates";
  if (!onList) return <>{children}</>;
  if (!canView) return <NoAccess />;

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileSignature className="size-5 text-muted-foreground" aria-hidden />
          <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        </div>
        {canSend ? (
          <Link href="/sign/new" className={cn(buttonVariants({ size: "lg" }))}>
            <Plus aria-hidden />
            {t("newDocument")}
          </Link>
        ) : null}
      </div>
      <nav aria-label={t("sections")} className="mb-5 flex gap-1 border-b border-border">
        {TABS.map((tab) => {
          const current = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={current ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(tab.labelKey)}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
