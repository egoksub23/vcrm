"use client";

// ============================================================
// Doc Sign, the documents list: the two shortcuts above the status chips.
//
//   Awaiting my signature  the documents where the signed-in person is a Halo user named as a signer and it is their
//                          turn, each with "Sign now" (their own turn, identity from their login)
//   Needs attention        documents that were declined, expired or failed to seal, and open ones where a message did
//                          not arrive
//
// Each is its own list read through the routes (the work is in service/countersign.ts); choosing one replaces the
// documents below, choosing it again goes back.
// ============================================================

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, Loader2, PenLine, TriangleAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { SignNowButton } from "@/components/sign/countersign/sign-now-button";
import { Button } from "@/components/ui/button";
import { sortedReasons, type AttentionItem, type AwaitingItem, type ListView } from "@/lib/sign/client/countersign";
import { cn } from "@/lib/utils";

interface BarProps {
  view: ListView;
  onView: (view: ListView) => void;
  /** Only a person who may countersign (sign.sign) sees "Awaiting my signature". */
  showAwaiting: boolean;
  awaitingCount: number;
  attentionCount: number;
}

const PILL = "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

/** The shortcut pills. A pressed one is the list on screen; pressing it again returns to the documents. */
export function ShortcutBar({ view, onView, showAwaiting, awaitingCount, attentionCount }: BarProps) {
  const t = useTranslations("Sign.send.list");
  const toggle = (v: Exclude<ListView, "documents">) => onView(view === v ? "documents" : v);
  return (
    <div role="group" aria-label={t("shortcuts.label")} className="flex flex-wrap gap-2">
      {showAwaiting ? (
        <button
          type="button"
          aria-pressed={view === "awaiting"}
          onClick={() => toggle("awaiting")}
          className={cn(PILL, view === "awaiting" ? "border-primary bg-primary/10 font-medium text-foreground" : awaitingCount > 0 ? "border-primary/50 text-foreground hover:bg-muted" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground")}
        >
          <PenLine className="size-3.5" aria-hidden />
          {t("awaiting.tab")}
          <span className={cn("rounded-full px-1.5 text-xs tabular-nums", awaitingCount > 0 ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>{awaitingCount}</span>
        </button>
      ) : null}
      <button
        type="button"
        aria-pressed={view === "attention"}
        onClick={() => toggle("attention")}
        className={cn(PILL, view === "attention" ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground")}
      >
        <TriangleAlert className={cn("size-3.5", attentionCount > 0 && "text-amber-600 dark:text-amber-300")} aria-hidden />
        {t("attention.tab")}
        <span className={cn("text-xs tabular-nums", attentionCount > 0 ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{attentionCount}</span>
      </button>
    </div>
  );
}

interface PanelState {
  loading: boolean;
  failed: boolean;
  reload: () => void;
}

function PanelShell({ state, empty, children }: { state: PanelState; empty: boolean; children?: ReactNode }) {
  const t = useTranslations("Sign.send.list");
  if (state.loading) {
    return (
      <div className="flex h-24 items-center justify-center" role="status" aria-label={t("loading")}>
        <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
      </div>
    );
  }
  if (state.failed && empty) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t("loadFailed")}</span>
        <Button type="button" variant="outline" size="sm" onClick={state.reload}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  return <>{children}</>;
}

export function AwaitingPanel({ items, loading, failed, reload }: { items: readonly AwaitingItem[] } & PanelState) {
  const t = useTranslations("Sign.send.list.awaiting");
  const f = useFormatter();
  const day = (iso: string) => f.dateTime(new Date(iso), { dateStyle: "medium" });
  return (
    <section aria-label={t("tab")} className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
      <PanelShell state={{ loading, failed, reload }} empty={items.length === 0}>
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">{t("empty")}</div>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {items.map((item) => (
              <li key={item.signerId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <Link href={`/sign/${item.documentId}`} className="block truncate font-medium text-foreground hover:underline">
                    {item.title}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">{[item.reference, t("role", { role: item.roleLabel }), item.step ? t("step", { step: item.step }) : null].filter(Boolean).join(" · ")}</p>
                  <p className="text-xs text-muted-foreground">
                    {[item.senderName ? t("from", { name: item.senderName }) : null, item.sentAt ? t("sent", { date: day(item.sentAt) }) : null, item.expiresAt ? t("expires", { date: day(item.expiresAt) }) : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Link href={`/sign/${item.documentId}`} className="text-sm text-primary hover:underline">
                    {t("view")}
                  </Link>
                  <SignNowButton documentId={item.documentId} onRefused={reload} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelShell>
    </section>
  );
}

export function AttentionPanel({ items, loading, failed, reload }: { items: readonly AttentionItem[] } & PanelState) {
  const t = useTranslations("Sign.send.list.attention");
  const f = useFormatter();
  return (
    <section aria-label={t("tab")} className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
      <PanelShell state={{ loading, failed, reload }} empty={items.length === 0}>
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">{t("empty")}</div>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {items.map((item) => (
              <li key={item.documentId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <Link href={`/sign/${item.documentId}`} className="block truncate font-medium text-foreground hover:underline">
                    {item.title}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">{[item.reference, f.dateTime(new Date(item.at), { dateStyle: "medium", timeStyle: "short" })].filter(Boolean).join(" · ")}</p>
                  <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {sortedReasons(item.reasons).map((reason) => (
                      <li key={reason} className="flex flex-wrap items-center gap-x-2 text-xs">
                        <span
                          className={cn(
                            "inline-flex h-5 items-center rounded-full px-2 font-medium",
                            reason === "expired" ? "bg-orange-500/15 text-orange-700 dark:text-orange-300" : reason === "undelivered" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-red-500/15 text-red-700 dark:text-red-300",
                          )}
                        >
                          {t(`reason.${reason}`)}
                        </span>
                        {item.people.length > 0 || reason === "failed" ? <span className="text-muted-foreground">{t(`detail.${reason}`, { names: f.list(item.people, { type: "conjunction", style: "short" }) })}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
                <Link href={`/sign/${item.documentId}`} className="text-sm text-primary hover:underline">
                  {t("open")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PanelShell>
    </section>
  );
}
