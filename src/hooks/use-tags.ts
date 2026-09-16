"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Tag } from "@/types";

/**
 * Account-scoped tag palette (RLS-scoped read of the `tags` table).
 * Shared by every surface that offers a tag picker over the same
 * palette — contact tags, conversation labels, automation config —
 * so the fetch-once-and-share logic lives in exactly one place.
 */
export function useTags(): { tags: Tag[]; loading: boolean } {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("tags")
      .select("*")
      .order("name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[useTags] fetch error:", error);
          setLoading(false);
          return;
        }
        setTags((data as Tag[]) ?? []);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { tags, loading };
}
