"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";

export interface ActiveTemplate {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  pages: number;
  roles: number;
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
        const supabase = createClient();
        const t = await supabase.from("sign_templates").select("id, name, description, category_id, current_version_id").eq("status", "active").order("name", { ascending: true });
        if (t.error) throw t.error;
        const list = ((t.data as { id: string; name: string; description: string | null; category_id: string | null; current_version_id: string | null }[] | null) ?? []).filter((x) => x.current_version_id);
        const versionIds = list.map((x) => x.current_version_id as string);
        const info = new Map<string, { pages: number; roles: number }>();
        if (versionIds.length) {
          const v = await supabase.from("sign_template_versions").select("id, page_count, roles").in("id", versionIds);
          if (v.error) throw v.error;
          for (const row of (v.data as { id: string; page_count: number; roles: unknown }[] | null) ?? []) {
            info.set(row.id, { pages: row.page_count, roles: Array.isArray(row.roles) ? row.roles.length : 0 });
          }
        }
        if (cancelled) return;
        setLoaded({
          accountId,
          error: false,
          rows: list.map((x) => ({ id: x.id, name: x.name, description: x.description, category_id: x.category_id, pages: info.get(x.current_version_id as string)?.pages ?? 0, roles: info.get(x.current_version_id as string)?.roles ?? 0 })),
        });
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
