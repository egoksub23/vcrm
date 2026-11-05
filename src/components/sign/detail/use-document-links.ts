"use client";

// ============================================================
// Doc Sign, the detail screen: the names behind the ids a document carries (its category, contact, ticket and
// deal), read from the browser through row level security. Anything that cannot be read is simply left out.
// ============================================================

import { useEffect, useState } from "react";


export interface DocumentLinks {
  category: string | null;
  contact: { id: string; label: string } | null;
  ticket: { id: string; number: number; subject: string } | null;
  deal: { id: string; title: string } | null;
}

export interface LinkIds {
  categoryId: string | null;
  contactId: string | null;
  ticketId: string | null;
  dealId: string | null;
}

const EMPTY: DocumentLinks = { category: null, contact: null, ticket: null, deal: null };

export function useDocumentLinks(ids: LinkIds | null): DocumentLinks {
  const key = ids ? `${ids.categoryId}|${ids.contactId}|${ids.ticketId}|${ids.dealId}` : "";
  const [loaded, setLoaded] = useState<{ key: string; links: DocumentLinks } | null>(null);

  useEffect(() => {
    if (!ids || !key || key === "null|null|null|null") return;
    let cancelled = false;
    (async () => {
      const [categoryRes, contactRes, ticketRes, dealRes] = await Promise.all([
        ids.categoryId ? fetch(`/api/sign/categories/${encodeURIComponent(ids.categoryId)}`).then((r) => r.json()).catch(() => ({})) : null,
        ids.contactId ? fetch(`/api/contacts/${encodeURIComponent(ids.contactId)}`).then((r) => r.json()).catch(() => ({})) : null,
        ids.ticketId ? fetch(`/api/tickets/${encodeURIComponent(ids.ticketId)}`).then((r) => r.json()).catch(() => ({})) : null,
        ids.dealId ? fetch(`/api/deals/${encodeURIComponent(ids.dealId)}`).then((r) => r.json()).catch(() => ({})) : null,
      ]);
      if (cancelled) return;
      const c = contactRes?.contact as { id: string; name?: string | null; phone?: string | null } | null | undefined;
      const ticket = ticketRes?.ticket as { id: string; ticket_number: number; subject: string } | null | undefined;
      const d = dealRes?.deal as { id: string; title: string } | null | undefined;
      setLoaded({
        key,
        links: {
          category: (categoryRes?.category as { name?: string } | null | undefined)?.name ?? null,
          contact: c ? { id: c.id, label: c.name?.trim() || c.phone || "" } : null,
          ticket: ticket ? { id: ticket.id, number: ticket.ticket_number, subject: ticket.subject } : null,
          deal: d ? { id: d.id, title: d.title } : null,
        },
      });
    })();
    return () => {
      cancelled = true;
    };
    // `ids` is read through `key`, which changes exactly when its values do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return loaded && loaded.key === key ? loaded.links : EMPTY;
}
