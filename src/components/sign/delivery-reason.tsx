"use client";

// Doc Sign: why a message did not arrive, in a short sentence in the reader's language. A failed delivery carries a `detail` string: a named reason
// (`daily_limit`, `mailbox_reconnect`, ...) with or without what the mail service said, or only what the service said. The words are Sign.delivery.

import { useCallback } from "react";
import { useTranslations } from "next-intl";

import { reasonOfDetail, technicalOfDetail } from "@/lib/email/send-reason";

/** The sentence for a delivery's `detail` ("Reason: ..."), or null when there is nothing to say. */
export function useDeliveryReason(): (detail: string | null | undefined) => string | null {
  const t = useTranslations("Sign.delivery");
  return useCallback(
    (detail) => {
      if (!detail || !detail.trim()) return null;
      const reason = reasonOfDetail(detail);
      const said = reason ? t(`reasons.${reason}`) : t("reasons.other", { detail: technicalOfDetail(detail).slice(0, 200) });
      return t("reasonLine", { reason: said });
    },
    [t],
  );
}

/** The reason a message did not arrive, under what says it did not. Nothing when there is no reason to give. */
export function DeliveryReason({ detail, className }: { detail: string | null | undefined; className?: string }) {
  const sentence = useDeliveryReason()(detail);
  if (!sentence) return null;
  return (
    <p className={className ?? "text-xs text-muted-foreground"} data-delivery-reason>
      {sentence}
    </p>
  );
}

/** Whether the reason is about how email is set up or limited (not about this person's address): then "check the address" would mislead. */
export function isSetupReason(detail: string | null | undefined): boolean {
  const reason = reasonOfDetail(detail);
  return reason !== null && reason !== "address_rejected";
}
