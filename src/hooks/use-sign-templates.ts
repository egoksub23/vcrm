"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";

export interface ActiveTemplate {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  pages: number;
  roles: number;
  /** A form without a signature (migration 169): there are no pages to show. */
  mode?: "sign" | "form";
}

interface Loaded {
  accountId: string;
  rows: ActiveTemplate[];
  error: boolean;
}

/**
 * The templates a document can start from: active ones that have a saved version, with the page and role
 * counts of that version. Read through row level security (menu.sign).
 */
export function useActiveTemplates(): { templates: ActiveTemplate[]; loading: boolean; error: boolean } {
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/sign/templates");
        if (!res.ok) throw new Error("fetch failed");
        const { templates } = (await res.json()) as { templates?: ActiveTemplate[] };
        if (cancelled) return;
        setLoaded({ accountId, error: false, rows: templates ?? [] });
      } catch (err) {
        if (cancelled) return;
        console.error("[useActiveTemplates] fetch error:", err);
        setLoaded({ accountId, rows: [], error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const ready = !!loaded && loaded.accountId === accountId;
  return { templates: ready ? loaded.rows : [], loading: !ready, error: ready ? loaded.error : false };
}
