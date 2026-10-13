"use client";

// ============================================================
// Compliance requests, the personal closure form link in a chat (migration 185): the presentational pieces the raise dialog, the Inbox card and the case page
// share. They take everything as props (the only state is the "Copied" flash), so they render the same in the app and in the render tests.
//
// The personal address appears in ONE place: `ChatLinkResult` with an outcome of status "not_sent", which is handed to the agent who just made the link so
// they can copy it. It is held by this component only while it is on screen, is never put in a URL, a storage or a log, and the text says it is shown once.
// ============================================================

import { CheckCircle2, Copy, Info, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { chip, TONE } from "@/components/comments/chips";
import { Button } from "@/components/ui/button";
import type { LinkState } from "@/lib/compliance/chat-link/link-state";
import type { ChatLinkOutcome } from "@/lib/compliance/chat-link/types";
import { cn } from "@/lib/utils";

/** The tone of a link's state chip. A state is always a word, never colour alone. */
export const LINK_STATE_TONE: Record<LinkState, string> = {
  created: TONE.muted,
  sent: TONE.primary,
  opened: TONE.primary,
  submitted: TONE.ok,
  expired: TONE.warn,
  revoked: TONE.muted,
  replaced: TONE.muted,
};

/** "Sent", "Opened", "Submitted", "Expired", "Withdrawn", "Replaced", "Not sent". */
export function LinkStateChip({ state, className }: { state: LinkState; className?: string }) {
  const t = useTranslations("Compliance.chatLink.state");
  return (
    <span className={cn(chip, "px-2 py-0.5 text-[11px]", LINK_STATE_TONE[state], className)} data-link-state={state}>
      {t(state)}
    </span>
  );
}

/**
 * What came of putting the closure form in the chat, in words, with Copy link when the chat could not take it. `onCopy` is a hook for tests; by default the
 * browser's clipboard is used, and when it is not available the address is selected in a read-only box for the agent to copy by hand.
 */
export function ChatLinkResult({ outcome, onCopied }: { outcome: ChatLinkOutcome; onCopied?: () => void }) {
  const t = useTranslations("Compliance.chatLink");
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  if (outcome.status === "sent") {
    return (
      <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-chat-link="sent" data-mode={outcome.mode}>
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[light-dark(#047857,#6ee7b7)]" aria-hidden />
        <span>{outcome.mode === "card" ? t("outcome.sentCard") : t("outcome.sentText")}</span>
      </div>
    );
  }

  if (outcome.status === "unavailable") {
    return (
      <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-chat-link="unavailable">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t(`outcome.unavailable.${outcome.reason}`)}</span>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(outcome.url);
      setCopied(true);
      onCopied?.();
    } catch {
      // no clipboard (an insecure page, a refusal): show the address selected, for the agent to copy by hand
      setManual(true);
      window.setTimeout(() => box.current?.select(), 0);
    }
  };

  return (
    <div role="alert" className="space-y-2 rounded-lg border border-[light-dark(#fcd34d,#92400e)] bg-[light-dark(#fffbeb,#451a03)] px-3 py-2 text-sm text-[light-dark(#451a03,#fef3c7)]" data-chat-link="not_sent" data-reason={outcome.reason}>
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t("outcome.notSent")}</span>
      </p>
      <p>{t(`outcome.reason.${outcome.reason}`)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void copy()} data-action="copy-link">
          <Copy className="size-3.5" aria-hidden />
          {copied ? t("copied") : t("copy")}
        </Button>
        <span aria-live="polite" className="sr-only">{copied ? t("copied") : ""}</span>
      </div>
      {manual ? <input ref={box} readOnly value={outcome.url} aria-label={t("copy")} className="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground" onFocus={(e) => e.currentTarget.select()} /> : null}
      <p className="text-xs opacity-80">{t("copyHint")}</p>
    </div>
  );
}
