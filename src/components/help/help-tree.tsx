"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { BookMarked, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { parseHelpPath } from "@/lib/help/nav";
import type { HelpNavSection } from "@/lib/help/types";

interface HelpTreeProps {
  nav: HelpNavSection[];
  /** Called when a link is followed (closes the mobile drawer). */
  onNavigate?: () => void;
}

/**
 * Left-hand tree: collapsible sections, the current page highlighted. The
 * section that holds the current page is open by default and opens again when
 * you navigate into it; other sections stay as you left them.
 */
export function HelpTree({ nav, onNavigate }: HelpTreeProps) {
  const t = useTranslations("Help");
  const pathname = usePathname();
  const active = parseHelpPath(pathname);

  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Re-open the active section when the route moves into it ("adjust state
  // while rendering", the React-recommended alternative to an effect).
  const [seenSection, setSeenSection] = useState(active.section);
  if (seenSection !== active.section) {
    setSeenSection(active.section);
    if (active.section) setOverrides((o) => ({ ...o, [active.section as string]: true }));
  }

  const isOpen = (slug: string) => overrides[slug] ?? slug === active.section;
  const toggle = (slug: string) => setOverrides((o) => ({ ...o, [slug]: !isOpen(slug) }));

  const onHome = pathname.replace(/\/+$/, "") === "/help";

  return (
    <nav aria-label={t("guideMenu")} className="text-sm">
      <Link
        href="/help"
        onClick={onNavigate}
        aria-current={onHome ? "page" : undefined}
        className={cn(
          "mb-2 flex items-center gap-2 rounded-md px-2 py-1.5 font-medium transition-colors hover:bg-muted/70",
          onHome ? "bg-primary-soft text-primary" : "text-foreground",
        )}
      >
        <BookMarked className="size-4 shrink-0" aria-hidden="true" />
        {t("home")}
      </Link>

      <ul className="flex flex-col gap-0.5">
        {nav.map((section) => {
          const open = isOpen(section.slug);
          const listId = `help-tree-${section.slug}`;
          return (
            <li key={section.slug}>
              <button
                type="button"
                onClick={() => toggle(section.slug)}
                aria-expanded={open}
                aria-controls={listId}
                aria-label={t(open ? "collapseSection" : "expandSection", { section: section.title })}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                <span className="truncate">{section.title}</span>
                <ChevronRight
                  className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
                  aria-hidden="true"
                />
              </button>
              {open ? (
                <ul id={listId} className="mb-2 ml-2 flex flex-col gap-0.5 border-l border-border pl-2">
                  {section.pages.map((page) => {
                    const current = section.slug === active.section && page.slug === active.page;
                    return (
                      <li key={page.href}>
                        <Link
                          href={page.href}
                          onClick={onNavigate}
                          aria-current={current ? "page" : undefined}
                          className={cn(
                            "block rounded-md px-2 py-1.5 leading-snug transition-colors",
                            current
                              ? "bg-primary-soft font-medium text-primary"
                              : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                          )}
                        >
                          {page.title}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
