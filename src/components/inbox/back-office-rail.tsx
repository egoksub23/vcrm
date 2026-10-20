"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  backOfficeRailWidthPx,
  browserStorage,
  readRailExpanded,
  writeRailExpanded,
} from "@/lib/back-office/rail";
import { cn } from "@/lib/utils";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Minimised (icon only) or expanded (label beside the icon), remembered in this browser. The first render is always minimised so the
 * server and the browser agree; the stored choice is applied right after mount.
 */
export function useBackOfficeRailExpanded() {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    // Reconcile with the stored choice after mount: reading it in the initializer would make the server and first client render disagree.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(readRailExpanded(browserStorage()));
  }, []);
  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      writeRailExpanded(browserStorage(), next);
      return next;
    });
  }, []);
  return { expanded, toggle };
}

/**
 * A narrow rail of quick actions on the right of the Inbox, beside the Customer information panel (extra screens only: below that the same action
 * is a button in the conversation header). Today it holds one action, "Open in Vircle Back Office", which opens the Back Office panel. More can be
 * added as further buttons in the same stack; the chevron expands or minimises them all together.
 */
export function BackOfficeRail({
  expanded,
  onToggleExpanded,
  onOpen,
  minimized = false,
}: {
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpen: () => void;
  /** A Back Office panel was put away into this rail: the button says so and brings it back. */
  minimized?: boolean;
}) {
  const t = useTranslations("Inbox.backOffice");
  const toggleLabel = expanded ? t("collapseRail") : t("expandRail");
  const openLabel = minimized ? t("railLabelMinimised") : t("railLabel");
  return (
    <aside
      aria-label={t("railRegion")}
      data-testid="back-office-rail"
      data-expanded={expanded ? "true" : "false"}
      className="hidden h-full shrink-0 flex-col gap-1 border-l border-border bg-card p-1.5 xl:flex"
      style={{ width: backOfficeRailWidthPx(expanded) }}
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-label={toggleLabel}
        title={toggleLabel}
        aria-expanded={expanded}
        className={cn(
          "inline-flex h-6 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          FOCUS_RING,
        )}
      >
        {expanded ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <ChevronLeft className="h-4 w-4" aria-hidden="true" />}
      </button>

      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        title={openLabel}
        aria-haspopup="dialog"
        data-minimized={minimized ? "true" : "false"}
        className={cn(
          "flex w-full items-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          expanded ? "gap-2.5" : "justify-center",
          minimized && "bg-muted text-foreground",
          FOCUS_RING,
        )}
      >
        <span className="relative shrink-0">
          <Building2 className="h-5 w-5" aria-hidden="true" />
          {minimized && <span aria-hidden="true" data-testid="back-office-minimised-dot" className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-card" />}
        </span>
        {expanded && (
          <span className="min-w-0 text-left">
            <span className="block truncate text-sm font-medium text-foreground">{t("railTitle")}</span>
            <span className="block truncate text-xs text-muted-foreground">{t("railHint")}</span>
          </span>
        )}
      </button>
    </aside>
  );
}
