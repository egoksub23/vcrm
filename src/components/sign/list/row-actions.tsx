"use client";

// ============================================================
// The documents list, one row's actions (migration 181): a small "more" menu that holds "Cancel document" for a completed document, or a completed
// collection, that was not cancelled yet, and only for the person who made it and for admins. The server decides again. Bulk actions on the list never
// offer it. The menu is a sibling of the row's link (never inside it), so opening it does not open the document.
// ============================================================

import { useState } from "react";
import { CircleOff, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";

import { CancelDialog, type CancelTarget } from "@/components/sign/detail/cancel-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { SignListRow } from "@/hooks/use-sign-documents";
import { canCancelRow, type CancelViewer } from "@/lib/sign/cancel";
import { cn } from "@/lib/utils";

/** What cancelling this row would cancel: the document, or the collection with every document in it. */
export function cancelTargetOf(row: Pick<SignListRow, "id" | "kind" | "envelope_documents">): CancelTarget {
  return row.kind === "envelope" ? { kind: "collection", id: row.id, documents: row.envelope_documents?.length ?? 0 } : { kind: "document", id: row.id };
}

interface Props {
  row: SignListRow;
  viewer: CancelViewer;
  /** Called after the row was cancelled (the list reads itself again). */
  onChanged: () => void;
  className?: string;
}

export function RowActions({ row, viewer, onChanged, className }: Props) {
  const t = useTranslations("Sign.send.list");
  const [cancelling, setCancelling] = useState(false);
  // nothing to offer: no menu at all (not an empty one)
  if (!canCancelRow(row, viewer)) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("rowActions", { title: row.title })}
          className={cn("inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", className)}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => setCancelling(true)} className="text-[light-dark(#b91c1c,#fca5a5)]">
            <CircleOff className="size-4" aria-hidden />
            {t("cancelAction")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {cancelling ? <CancelDialog target={cancelTargetOf(row)} title={row.title} onClose={() => setCancelling(false)} onCancelled={onChanged} /> : null}
    </>
  );
}
