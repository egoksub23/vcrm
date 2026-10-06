"use client";

// The Doc Sign documents attached to a ticket (F-51): a panel on the ticket page, the same component the contact's Documents tab
// uses. Shown only to people who can see Doc Sign (menu.sign).

import { RecordDocuments } from "@/components/sign/detail/contact-documents";
import { useCapability } from "@/hooks/use-can";

export function TicketDocumentsSection({ ticketId, contactId }: { ticketId: string; contactId: string | null }) {
  const canSee = useCapability("menu.sign");
  if (!canSee) return null;
  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <RecordDocuments kind="ticket" id={ticketId} contactId={contactId} />
    </section>
  );
}
