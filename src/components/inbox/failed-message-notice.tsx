"use client";

import { Info, Loader2, RotateCw, Trash2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { readOnlyTitle } from "@/components/ui/gated-button";
import { useCapability } from "@/hooks/use-auth";
import type { Message } from "@/types";
import { useFailureText } from "./failure-text";

interface FailedMessageNoticeProps {
  message: Message;
  /** Sends the same content again. Omitted for a bubble that was never saved. */
  onResend?: () => void;
  /** Removes the failed message from the chat. */
  onDelete?: () => void;
  /** A resend is in flight. */
  resending?: boolean;
  /** Full-width card layout (rendered email) instead of a chat bubble's tail. */
  wide?: boolean;
}

/**
 * The red "Not sent" panel under a message that did not go out: the friendly
 * reason, an info popover with the provider's own details, and Resend /
 * Delete. Both actions need the same capability as sending a message.
 */
export function FailedMessageNotice({
  message,
  onResend,
  onDelete,
  resending = false,
  wide = false,
}: FailedMessageNoticeProps) {
  const t = useTranslations("Inbox.failure");
  const tChannel = useTranslations("Inbox.messageThread");
  const failureText = useFailureText();
  const canSend = useCapability("messages.send");
  const gateHint = canSend ? undefined : readOnlyTitle("send messages");

  const hasReason = message.error_code != null || !!message.error_title || !!message.error_details;
  const text = hasReason
    ? failureText({
        code: message.error_code,
        title: message.error_title,
        details: message.error_details,
        channel: message.channel_type,
      })
    : null;

  return (
    <div
      role="group"
      aria-label={t("notSent")}
      data-testid="failed-message-notice"
      className={cn(
        "mt-1 flex flex-col gap-1.5 rounded-lg border border-red-500/40 bg-red-500/5 px-2.5 py-1.5 text-xs",
        wide ? "mx-3 mb-2" : "max-w-full",
      )}
    >
      <div className="flex items-start gap-1.5">
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
        <div className="min-w-0 flex-1 text-left">
          <p className="font-semibold text-red-600 dark:text-red-400">{t("notSent")}</p>
          <p className="break-words text-foreground">{text ? text.title : t("noReason")}</p>
          {text && <p className="break-words text-muted-foreground">{text.action}</p>}
        </div>
        {hasReason && (
          <Popover>
            <PopoverTrigger
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("details")}
              title={t("details")}
            >
              <Info className="h-3.5 w-3.5" />
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-1.5 p-3 text-xs" sideOffset={6}>
              <p className="font-semibold text-foreground">{t("detailsHeading")}</p>
              <dl className="space-y-1">
                <div>
                  <dt className="text-muted-foreground">{t("channel")}</dt>
                  <dd className="text-foreground">
                    {tChannel(`channel.${message.channel_type}`)}
                  </dd>
                </div>
                {message.error_code != null && (
                  <div>
                    <dt className="text-muted-foreground">{t("code")}</dt>
                    <dd className="font-mono text-foreground">{message.error_code}</dd>
                  </div>
                )}
                {message.error_title && (
                  <div>
                    <dt className="text-muted-foreground">{t("providerMessage")}</dt>
                    <dd className="break-words text-foreground">{message.error_title}</dd>
                  </div>
                )}
                {message.error_details && (
                  <div>
                    <dt className="text-muted-foreground">{t("providerDetails")}</dt>
                    <dd className="break-words text-foreground">{message.error_details}</dd>
                  </div>
                )}
              </dl>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {(onResend || onDelete) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {onResend && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={onResend}
              disabled={!canSend || resending}
              title={gateHint}
              data-testid="failed-message-resend"
            >
              {resending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <RotateCw aria-hidden />
              )}
              {resending ? t("resending") : t("resend")}
            </Button>
          )}
          {onDelete && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onDelete}
              disabled={!canSend || resending}
              title={gateHint}
              data-testid="failed-message-delete"
              className="text-muted-foreground hover:text-red-500"
            >
              <Trash2 aria-hidden />
              {t("delete")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
