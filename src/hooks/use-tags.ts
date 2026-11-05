"use client";

import { useEffect, useMemo, useState } from "react";
import { isContactTag, isConversationLabel } from "@/lib/tags/scope";
import type { Tag } from "@/types";

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
    fetch("/api/account/tags")
      .then((r) => r.json())
      .then(({ tags: data }: { tags?: Tag[] }) => {
        if (cancelled) return;
        setTags(data ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useTags] fetch error:", err);
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
