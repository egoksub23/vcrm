"use client";

import { useTranslations } from "next-intl";

import type { StatusGroup } from "@/lib/sign/client/list-filters";

/** The groups that need a sentence: what Completed, Cancelled and All each contain (migration 181). The others say what they are by their name. */
export const GROUPS_WITH_HELP: readonly StatusGroup[] = ["all", "completed", "cancelled"];

/**
 * Under the status filters: "Completed" leaves out the documents that were cancelled after they were completed (they are under "Cancelled"), and "All"
 * has everything. A cancelled document is a completed record in every other respect, so the list says where it went.
 */
export function GroupHelp({ group }: { group: StatusGroup }) {
  const t = useTranslations("Sign.send.list");
  if (!GROUPS_WITH_HELP.includes(group)) return null;
  return (
    <p className="-mt-2 text-xs text-muted-foreground" data-filter-help={group}>
      {t(`groupHelp.${group as "all" | "completed" | "cancelled"}`)}
    </p>
  );
}
