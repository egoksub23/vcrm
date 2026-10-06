"use client";

// Two things the builder asks the workspace, with the browser client through row level security: the workspace's own contact
// fields (an answer can fill one), and whether any document was ever made from this template (after that, keys are not edited).

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/** The names of the workspace's contact fields (`custom_fields`), for mapping an answer to one. Empty until read. */
export function useCustomContactFields(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await createClient().from("custom_fields").select("field_name").order("field_name");
        if (!cancelled && data) setNames((data as { field_name: string }[]).map((r) => r.field_name).filter((n) => typeof n === "string" && n.length > 0));
      } catch {
        // without the list the built-in contact fields still work
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

/**
 * Has any document been made from a version of this template? `null` until known (and when it cannot be read): the builder then treats
 * keys as locked, which is the safe side.
 */
export function useTemplateUsed(versionIds: readonly string[]): boolean | null {
  const [used, setUsed] = useState<boolean | null>(null);
  const ids = versionIds.join(",");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (ids === "") {
        if (!cancelled) setUsed(false);
        return;
      }
      try {
        const { count, error } = await createClient().from("sign_documents").select("id", { count: "exact", head: true }).in("template_version_id", ids.split(","));
        if (!cancelled) setUsed(error ? null : (count ?? 0) > 0);
      } catch {
        if (!cancelled) setUsed(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ids]);
  return used;
}
