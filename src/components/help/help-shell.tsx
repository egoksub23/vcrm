"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Menu, Search } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { HelpSearchDialog } from "@/components/help/help-search";
import { HelpTree } from "@/components/help/help-tree";
import type { HelpNavSection } from "@/lib/help/types";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Frame around every /help page: search button and mobile menu on top, the
 * sticky section tree on the left (a drawer on small screens), the page in the
 * middle. Owns the Ctrl+K and "/" shortcuts.
 */
export function HelpShell({ nav, children }: { nav: HelpNavSection[]; children: React.ReactNode }) {
  const t = useTranslations("Help");
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Close the drawer and the palette when the route changes.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setMenuOpen(false);
    setSearchOpen(false);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const isCtrlK = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      const isSlash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditable(e.target);
      if (isCtrlK || isSlash) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mx-auto w-full max-w-7xl">
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label={t("openMenu")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label={t("searchButton")}
          className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 text-left text-sm text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground sm:max-w-md sm:flex-none sm:basis-96"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 truncate">{t("searchPlaceholder")}</span>
          <span className="hidden shrink-0 items-center gap-1 sm:flex" aria-hidden="true">
            <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">Ctrl</kbd>
            <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">K</kbd>
          </span>
        </button>
      </div>

      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
        <aside className="hidden lg:block">
          <div className="sticky top-2 max-h-[calc(100vh-9rem)] overflow-y-auto pr-1">
            <HelpTree nav={nav} />
          </div>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-4 sm:max-w-xs">
          <SheetTitle className="sr-only">{t("guideMenu")}</SheetTitle>
          <SheetDescription className="sr-only">{t("guideMenu")}</SheetDescription>
          <div className="overflow-y-auto pt-6">
            <HelpTree nav={nav} onNavigate={closeMenu} />
          </div>
        </SheetContent>
      </Sheet>

      <HelpSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
