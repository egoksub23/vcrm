"use client";

import { useTranslations } from "next-intl";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Ticket } from "@/types";
import { TicketDetail } from "./ticket-detail";

/**
 * The in-list ticket experience: the issue view in a large two-column modal
 * (near full screen, scrolls inside; a single full-screen column on a phone).
 * `/tickets/[id]` renders the same content as a page, so a copied link and a
 * browser refresh work.
 */
export function TicketDetailDialog({
  ticketId,
  onOpenChange,
  onChanged,
  onDeleted,
  onOpenTicket,
}: {
  ticketId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Lets the list refresh its row without waiting for realtime. */
  onChanged?: (id: string, patch?: Partial<Ticket>) => void;
  onDeleted?: (id: string) => void;
  /** Open another ticket (from a link) in this same dialog. */
  onOpenTicket: (id: string) => void;
}) {
  const t = useTranslations("Tickets.detail");
  return (
    <Dialog open={!!ticketId} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent
        className="flex h-[90vh] w-full max-w-[1100px] flex-col gap-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground sm:max-w-[1100px] max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
      >
        <DialogTitle className="sr-only">{t("dialogTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("dialogDescription")}</DialogDescription>
        {ticketId ? (
          <TicketDetail
            key={ticketId}
            ticketId={ticketId}
            variant="modal"
            onClose={() => onOpenChange(false)}
            onChanged={onChanged}
            onDeleted={onDeleted}
            onOpenTicket={onOpenTicket}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
