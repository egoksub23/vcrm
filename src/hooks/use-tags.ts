"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isContactTag, isConversationLabel } from "@/lib/tags/scope";
import type { Tag } from "@/types";

/**
 * Account-scoped tag palette (RLS-scoped read of the `tags` table).
 * One fetch shared by every picker: `contactTags` and
 * `conversationLabels` are the two lists Settings manages (migration
 * 068); `tags` is the full palette for surfaces that don't care
 * (e.g. rendering a chip for whatever is already attached).
 */
export function useTags(): {
  tags: Tag[];
  contactTags: Tag[];
  conversationLabels: Tag[];
  loading: boolean;
} {
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

  const contactTags = useMemo(() => tags.filter(isContactTag), [tags]);
  const conversationLabels = useMemo(() => tags.filter(isConversationLabel), [tags]);

  return { tags, contactTags, conversationLabels, loading };
}
