"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";

export interface ContactSummary {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export const CONTACT_COLUMNS = "id, name, email, phone, company";

/**
 * Search the workspace's contacts (name, phone, email, company) as the person types: the most recent contacts when the box is empty, up to 8.
 * Searches only while `open`. `searching` is true until the answer to the current text arrives.
 * Shared by the contact picker and by the name box of a person on a signing list.
 */
export function useContactSearch(query: string, open: boolean): { rows: ContactSummary[]; searching: boolean } {
  const { accountId } = useAuth();
  const [found, setFound] = useState<{ q: string; rows: ContactSummary[] } | null>(null);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    const handle = setTimeout(
      async () => {
        const params = new URLSearchParams({ limit: "8" });
        if (query.trim()) params.set("q", query.trim());
        const res = await fetch(`/api/contacts?${params}`).catch(() => null);
        const json = res?.ok ? await res.json().catch(() => null) : null;
        if (cancelled) return;
        setFound({ q: query, rows: (json?.contacts as ContactSummary[] | null) ?? [] });
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, accountId]);

  return { rows: found?.rows ?? [], searching: open && (!found || found.q !== query) };
}
