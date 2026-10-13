"use client";

// ============================================================
// The "Compliance requests" section of the Inbox ticket column (migration 185): the requests linked to the open chat or to its contact.
//
//   a person who holds the Compliance menu sees every one, each row a link to its case
//   anyone else sees only the requests THEY raised, each row plain text: reference, type, status and when. Never the customer, never a link
//   a workspace with Compliance off: the section is not drawn at all (the platform flag the browser holds AND the server's own `enabled`)
//
// Loaded with the person's own session through /api/compliance/linked, asked for again when the conversation changes and every 60 s while the tab is visible.
// What a row shows is built by linkedRows (lib/compliance/linked-view.ts), which copies only the allowed fields.
// ============================================================

import { ClipboardCheck, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { getLinked } from "@/components/compliance/api";
import { TONE_OF } from "@/components/compliance/raise";
import { useCapability } from "@/hooks/use-auth";
import { complianceSectionVisible, LINKED_POLL_MS, linkedCounts, linkedRows, type LinkedInput, type LinkedRowView } from "@/lib/compliance/linked-view";
import { cn } from "@/lib/utils";

/** What the section holds for one conversation. */
export interface LinkedHeld {
  conversationId: string;
  /** The server's own answer: false when the workspace has Compliance off. */
  enabled: boolean;
  items: LinkedInput[];
}

export interface LinkedCompliance {
  /** The server's `enabled`, or null until the first answer. */
  enabled: boolean | null;
  items: LinkedInput[];
  loading: boolean;
  failed: boolean;
}

/**
 * Loads the linked requests. Nothing is asked for while the workspace's Compliance flag is off. `initial` is for tests and previews (the first render has no
 * network).
 */
export function useLinkedCompliance(conversationId: string | null, featureOn: boolean, initial?: LinkedHeld | null): LinkedCompliance {
  const [held, setHeld] = useState<LinkedHeld | null>(initial ?? null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  // the newest request wins: an answer that arrives after the conversation changed is dropped
  const ticket = useRef(0);

  const load = useCallback(async () => {
    if (!conversationId) return;
    const mine = ++ticket.current;
    const res = await getLinked(conversationId);
    if (mine !== ticket.current) return;
    if (res.ok) {
      setHeld({ conversationId, enabled: res.data.enabled, items: res.data.items });
      setFailedFor(null);
    } else {
      // a failed read keeps what is known; it is tried again on the next tick
      setFailedFor(conversationId);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!featureOn || !conversationId) return;
    // load-on-change fetch whose result sets state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(tick, LINKED_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [featureOn, conversationId, load]);

  const current = held && held.conversationId === conversationId ? held : null;
  return {
    enabled: current ? current.enabled : null,
    items: current?.items ?? [],
    loading: !!conversationId && !current && failedFor !== conversationId,
    failed: !current && failedFor === conversationId,
  };
}

/** Is the section drawn? The platform flag AND the server's answer (see complianceSectionVisible). */
export const showLinkedSection = (featureOn: boolean, data: Pick<LinkedCompliance, "enabled">): boolean => complianceSectionVisible(featureOn, data.enabled);

function RowBody({ row }: { row: LinkedRowView }) {
  const t = useTranslations("Compliance.raise");
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs font-medium text-foreground">{row.reference}</span>
        <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium", TONE_OF[row.status])} data-status={row.status}>
          {t(`status.${row.status}`)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{row.typeLabel}</span>
        <span>{formatDistanceToNow(new Date(row.raisedAt), { addSuffix: true })}</span>
      </div>
    </>
  );
}

/** The section: a header with the count, and the rows (or its own empty state). It scrolls on its own. */
export function ComplianceRequestsSection({ data }: { data: LinkedCompliance }) {
  const t = useTranslations("Inbox.ticketHistory");
  const locale = useLocale();
  const canOpen = useCapability("menu.compliance");
  const titleId = useId();
  const rows = linkedRows(data.items, locale, canOpen);
  const counts = linkedCounts(data.items);

  return (
    <section aria-labelledby={titleId} className="flex h-full min-h-0 flex-col" data-testid="compliance-section">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-sm font-semibold text-foreground">{t("complianceTitle")}</h3>
          <p className="text-[11px] text-muted-foreground">
            {data.loading || counts.total === 0 ? t("complianceNone") : t("complianceSummary", { total: counts.total, open: counts.open })}
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.loading ? (
          <div className="flex justify-center py-6" role="status" aria-label={t("complianceLoading")}>
            <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
          </div>
        ) : data.failed ? (
          <p role="alert" className="px-4 py-6 text-center text-xs text-muted-foreground">{t("complianceFailed")}</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t("complianceEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border" aria-labelledby={titleId}>
            {rows.map((row) => (
              <li key={row.key} data-testid="compliance-row">
                {row.href ? (
                  <Link href={row.href} className="block px-3 py-2.5 transition-colors hover:bg-muted/50">
                    <RowBody row={row} />
                  </Link>
                ) : (
                  <div className="px-3 py-2.5">
                    <RowBody row={row} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
