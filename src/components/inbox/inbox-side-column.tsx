"use client";

import { ContactNotesPanel } from "./contact-notes-panel";
import { TicketHistoryPanel } from "./ticket-history-panel";

/**
 * The column between the chat and the contact details, split into two
 * equal halves: ticket history on top, customer notes below. Each half
 * scrolls independently, so a long ticket list never pushes the notes
 * off-screen (or the other way round).
 */
export function InboxSideColumn({
  contactId,
  conversationId,
}: {
  contactId: string | null;
  conversationId: string | null;
}) {
  return (
    <div className="flex h-full w-72 flex-col border-l border-border bg-card">
      <div className="min-h-0 flex-1">
        <TicketHistoryPanel contactId={contactId} conversationId={conversationId} />
      </div>
      <div className="min-h-0 flex-1 border-t-2 border-border">
        <ContactNotesPanel contactId={contactId} />
      </div>
    </div>
  );
}
