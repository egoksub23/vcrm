"use client";

import { useTranslations } from "next-intl";

import { badgeText } from "@/lib/sign/client/countersign";

/**
 * The round bubble on the sidebar's Sign item: how many documents wait for the signed-in person to sign (they are a
 * Halo user named on them and it is their turn). Styled like the Notifications and Tickets bubbles, hidden at zero,
 * "9+" from ten. The words are Doc Sign's own (`Sign.send.list`), not the sidebar's.
 */
export function AwaitingBadge({ count }: { count: number }) {
  const t = useTranslations("Sign.send.list");
  const text = badgeText(count);
  if (!text) return null;
  const label = t("awaiting.badge", { count });
  return (
    <span
      aria-label={label}
      title={label}
      data-sign-awaiting-badge="yes"
      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
    >
      {text}
    </span>
  );
}
