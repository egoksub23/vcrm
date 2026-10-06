"use client";

// ============================================================
// Doc Sign, the detail screen: the names behind the ids a document carries (its category, contact, ticket and
// deal), read from the browser through row level security. Anything that cannot be read is simply left out.
// ============================================================

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

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
      const supabase = createClient();
      const [category, contact, ticket, deal] = await Promise.all([
        ids.categoryId ? supabase.from("sign_categories").select("name").eq("id", ids.categoryId).maybeSingle() : null,
        ids.contactId ? supabase.from("contacts").select("id, name, phone").eq("id", ids.contactId).maybeSingle() : null,
        ids.ticketId ? supabase.from("tickets").select("id, ticket_number, subject").eq("id", ids.ticketId).maybeSingle() : null,
        ids.dealId ? supabase.from("deals").select("id, title").eq("id", ids.dealId).maybeSingle() : null,
      ]);
      if (cancelled) return;
      const c = contact?.data as { id: string; name?: string | null; phone?: string | null } | null | undefined;
      const t = ticket?.data as { id: string; ticket_number: number; subject: string } | null | undefined;
      const d = deal?.data as { id: string; title: string } | null | undefined;
      setLoaded({
        key,
        links: {
          category: (category?.data as { name?: string } | null | undefined)?.name ?? null,
          contact: c ? { id: c.id, label: c.name?.trim() || c.phone || "" } : null,
          ticket: t ? { id: t.id, number: t.ticket_number, subject: t.subject } : null,
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
