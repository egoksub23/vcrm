"use client";

import { useParams, useRouter } from "next/navigation";

import { TicketDetail } from "@/components/tickets/ticket-detail";

/**
 * A ticket as a full page: the same issue view as the modal on /tickets, at a
 * URL that survives a refresh and can be copied ("Copy link").
 */
export default function TicketPage() {
  const params = useParams();
  const router = useRouter();
  const ticketId = params.id as string;

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col overflow-hidden rounded-xl border border-border bg-card">
      <TicketDetail
        key={ticketId}
        ticketId={ticketId}
        variant="page"
        onClose={() => router.push("/tickets")}
        onOpenTicket={(id) => router.push(`/tickets/${id}`)}
      />
    </div>
  );
}
