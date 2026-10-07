"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";

export interface ContactSummary {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export const CONTACT_COLUMNS = "id, name, email, phone, company";

/** Characters that would break a PostgREST filter list are dropped. */
const safe = (q: string) => q.replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Search the workspace's contacts (name, phone, email, company) as the person types: the most recent contacts when the box is empty, up to 8.
 * Reads `contacts` through row level security, like the rest of the app. Searches only while `open`. `searching` is true until the answer to the
 * current text arrives. Shared by the contact picker and by the name box of a person on a signing list.
 */
export function useContactSearch(query: string, open: boolean): { rows: ContactSummary[]; searching: boolean } {
  const { accountId } = useAuth();
  const [found, setFound] = useState<{ q: string; rows: ContactSummary[] } | null>(null);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    const q = safe(query);
    const handle = setTimeout(
      async () => {
        let req = createClient().from("contacts").select(CONTACT_COLUMNS).is("deleted_at", null);
        req = q ? req.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%,company.ilike.%${q}%`) : req.order("created_at", { ascending: false });
        const { data } = await req.limit(8);
        if (cancelled) return;
        setFound({ q: query, rows: (data as ContactSummary[] | null) ?? [] });
      },
      q ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, accountId]);

  return { rows: found?.rows ?? [], searching: open && (!found || found.q !== query) };
}
