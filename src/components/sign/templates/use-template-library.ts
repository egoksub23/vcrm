"use client";

// Reads the template library with the browser client through row level security (menu.sign): the templates,
// how many versions each has, and the categories (for the filter and the labels).

import { useCallback, useEffect, useState } from "react";

import type { SignCategoryRow } from "@/lib/sign/client/admin-settings";
import { countVersions, type LibraryTemplate } from "@/lib/sign/client/template-library";
import { createClient } from "@/lib/supabase/client";

export type LibraryCategory = Pick<SignCategoryRow, "id" | "name" | "archived" | "position">;

type State = { status: "loading" } | { status: "error" } | { status: "ready"; templates: LibraryTemplate[]; categories: LibraryCategory[] };

const TEMPLATE_COLUMNS = "id, name, description, category_id, status, tags, addon_key, addon_version, customised, updated_at, mode";

export function useTemplateLibrary() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    const supabase = createClient();
    void Promise.all([
      supabase.from("sign_templates").select(TEMPLATE_COLUMNS).order("updated_at", { ascending: false }).limit(1000),
      supabase.from("sign_template_versions").select("template_id").limit(10000),
      supabase.from("sign_categories").select("id, name, archived, position").order("position", { ascending: true }),
    ]).then(([templates, versions, categories]) => {
      if (!live) return;
      if (templates.error || versions.error || categories.error) {
        setState({ status: "error" });
        return;
      }
      const counts = countVersions((versions.data ?? []) as { template_id: string }[]);
      setState({
        status: "ready",
        templates: ((templates.data ?? []) as Omit<LibraryTemplate, "versionCount">[]).map((t) => ({ ...t, tags: t.tags ?? [], versionCount: counts.get(t.id) ?? 0 })),
        categories: (categories.data ?? []) as LibraryCategory[],
      });
    }).catch(() => {
      if (live) setState({ status: "error" });
    });
    return () => {
      live = false;
    };
  }, [round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { state, reload };
}
