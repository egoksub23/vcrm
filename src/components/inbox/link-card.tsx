"use client";

// ============================================================
// The closure form card in the Inbox thread (migration 185): what the agent sees where the customer was sent a tappable card. NOT a bubble of raw text and never
// an address: the message row holds only the card's words and the link's id.
//
//   title, a short body, and a button-looking element with the stored label. The button is a picture of what the customer sees (disabled, aria-disabled): the
//   agent must not open the customer's personal form from here
//   a status line from the link ("Sent", "Opened", "Submitted", "Expired", "Withdrawn", "Replaced", "Not sent"), for a person who may read statuses
//   for a person who may manage the link (the server says so): Send again and Withdraw. Send again shows what came of it where the card is, with Copy link when
//   the chat could not take it (the one place the personal address appears, shown once and held only while it is on screen)
//
// The message's own time, channel and ticks, and the failed-message notice, are the bubble's: they are handed in as `meta` and `notice`.
// ============================================================

import { ClipboardSignature, Loader2, RotateCw, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { ChatLinkResult, LinkStateChip } from "@/components/compliance/chat-link-parts";
import { resendClosureForm, revokeClosureForm } from "@/components/compliance/api";
import { errorKey } from "@/components/compliance/helpers";
import { Button } from "@/components/ui/button";
import { cardActions, type CardView } from "@/lib/compliance/chat-link/card-view";
import type { ChatLinkOutcome } from "@/lib/compliance/chat-link/types";
import { cn } from "@/lib/utils";

import { useCardStatus } from "./card-status";

export function LinkCard({ view, failed, meta, notice }: { view: CardView; failed: boolean; meta: ReactNode; notice?: ReactNode }) {
  const t = useTranslations("Inbox.linkCard");
  const tErr = useTranslations("Compliance.errors");
  const { status, refresh } = useCardStatus(view.linkId);
  const actions = cardActions(status);
  const [busy, setBusy] = useState<"resend" | "withdraw" | null>(null);
  const [outcome, setOutcome] = useState<ChatLinkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resend = async () => {
    if (!status?.requestId || busy) return;
    setBusy("resend");
    setError(null);
    setOutcome(null);
    const res = await resendClosureForm(status.requestId);
    setBusy(null);
    if (res.ok) setOutcome(res.data.chatLink);
    else setError(errorKey(res.code));
    await refresh();
  };

  const withdraw = async () => {
    if (!status?.requestId || busy) return;
    setBusy("withdraw");
    setError(null);
    setOutcome(null);
    const res = await revokeClosureForm(status.requestId);
    setBusy(null);
    if (!res.ok) setError(errorKey(res.code));
    await refresh();
  };

  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5" data-testid="link-card">
      <div role="group" aria-label={t("ariaCard", { title: view.title })} className={cn("overflow-hidden rounded-2xl border bg-card text-card-foreground", failed ? "border-red-500/60 ring-2 ring-red-500/40" : "border-border")}>
        <div className="space-y-2 px-3 py-2.5">
          <p className="flex items-start gap-2 text-sm font-semibold text-foreground">
            <ClipboardSignature className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 break-words">{view.title}</span>
          </p>
          {view.body ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{view.body}</p> : null}
          {view.button ? (
            // A picture of the customer's button: not a link, not pressable, not in the tab order.
            <button
              type="button"
              disabled
              aria-disabled="true"
              tabIndex={-1}
              title={t("preview")}
              data-testid="link-card-button"
              className="flex h-9 w-full cursor-default items-center justify-center rounded-lg border border-border bg-muted px-3 text-sm font-medium text-primary"
            >
              {view.button}
            </button>
          ) : null}
          {status ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid="link-card-status">
              <span>{t("statusLabel")}</span>
              <LinkStateChip state={status.state} />
            </div>
          ) : null}
          {actions.resend || actions.withdraw ? (
            <div role="group" aria-label={t("actions")} className="flex flex-wrap items-center gap-1.5">
              {actions.resend ? (
                <Button type="button" size="xs" variant="outline" onClick={() => void resend()} disabled={busy !== null} data-testid="link-card-resend">
                  {busy === "resend" ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
                  {busy === "resend" ? t("working") : t("resend")}
                </Button>
              ) : null}
              {actions.withdraw ? (
                <Button type="button" size="xs" variant="ghost" onClick={() => void withdraw()} disabled={busy !== null} data-testid="link-card-withdraw" className="text-muted-foreground hover:text-foreground">
                  {busy === "withdraw" ? <Loader2 className="animate-spin" aria-hidden /> : <Undo2 aria-hidden />}
                  {busy === "withdraw" ? t("working") : t("withdraw")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {tErr(error)}
            </p>
          ) : null}
          {outcome ? <ChatLinkResult outcome={outcome} /> : null}
          {meta}
        </div>
      </div>
      {notice}
    </div>
  );
}
