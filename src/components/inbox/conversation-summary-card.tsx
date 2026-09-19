"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Copy, Loader2, RefreshCw, Sparkles, X } from "lucide-react";

/**
 * "Summarise this conversation" for the contact column: one click asks the
 * summary job for a few lines on who the customer is, what they want, what
 * has been promised and what is open. Shown in place, never stored. The
 * parent remounts it (via `key`) per conversation, so a summary never
 * lingers on the wrong chat.
 */
export function ConversationSummaryCard({ conversationId }: { conversationId: string }) {
  const t = useTranslations("Inbox.summary");
  const locale = useLocale();
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/ai/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, locale }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          data.code === "ai_not_configured"
            ? t("notConfigured")
            : data.code === "budget_exceeded"
              ? t("budget")
              : data.code === "no_messages"
                ? t("nothingYet")
                : t("failed"),
        );
        return;
      }
      setSummary(String(data.summary ?? ""));
    } catch {
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  if (!summary) {
    return (
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-primary" />}
        {busy ? t("working") : t("button")}
      </button>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3 w-3 text-primary" />
        <span className="flex-1">{t("title")}</span>
        <button type="button" onClick={() => void run()} disabled={busy} className="rounded p-1 hover:bg-muted hover:text-foreground" aria-label={t("refresh")} title={t("refresh")}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </button>
        <button type="button" onClick={() => void copy()} className="rounded p-1 hover:bg-muted hover:text-foreground" aria-label={t("copy")} title={t("copy")}>
          {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
        </button>
        <button type="button" onClick={() => setSummary(null)} className="rounded p-1 hover:bg-muted hover:text-foreground" aria-label={t("hide")} title={t("hide")}>
          <X className="h-3 w-3" />
        </button>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{summary}</p>
      <p className="mt-2 text-[10px] text-muted-foreground">{t("disclaimer")}</p>
    </div>
  );
}
