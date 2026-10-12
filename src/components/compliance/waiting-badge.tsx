"use client";

import { useTranslations } from "next-intl";

import { badgeText } from "@/lib/sign/client/countersign";

/**
 * The round bubble on the sidebar's Compliance item: how many requests wait for the signed-in person (cases awaiting their sign-off, cases waiting for
 * an identity check or an officer's review). Styled like the Secure Sign, Notifications and Tickets bubbles, hidden at zero, "9+" from ten.
 */
export function ComplianceWaitingBadge({ count }: { count: number }) {
  const t = useTranslations("Compliance.badge");
  const text = badgeText(count);
  if (!text) return null;
  const label = t("waiting", { count });
  return (
    <span
      aria-label={label}
      title={label}
      data-compliance-waiting-badge="yes"
      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
    >
      {text}
    </span>
  );
}
