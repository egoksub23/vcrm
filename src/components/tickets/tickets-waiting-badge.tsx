"use client";

import { useTranslations } from "next-intl";

import { badgeLabel } from "@/lib/approvals/rules";

/**
 * The round bubble on the sidebar's Tickets item: how many tickets have an open
 * "needs your response" request on the signed-in person (migration 095). Styled
 * like the Notifications bubble, hidden at zero, "9+" from ten.
 */
export function TicketsWaitingBadge({ count }: { count: number }) {
  const t = useTranslations("Sidebar");
  if (!count || count < 1) return null;
  const label = t("ticketsWaiting", { count });
  return (
    <span
      aria-label={label}
      title={label}
      data-tickets-waiting-badge="yes"
      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
    >
      {badgeLabel(count)}
    </span>
  );
}
