"use client";

// Reads the template library with the browser client through row level security (menu.sign): the templates,
// how many versions each has, and the categories (for the filter and the labels).

import { useCallback, useEffect, useState } from "react";

import type { SignCategoryRow } from "@/lib/sign/client/admin-settings";
import type { LibraryTemplate } from "@/lib/sign/client/template-library";

export type LibraryCategory = Pick<SignCategoryRow, "id" | "name" | "archived" | "position">;

type State = { status: "loading" } | { status: "error" } | { status: "ready"; templates: LibraryTemplate[]; categories: LibraryCategory[] };

export function useTemplateLibrary() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    void fetch("/api/sign/templates?library=true")
      .then((r) => r.json())
      .then((json: { templates?: Omit<LibraryTemplate, "versionCount"> & { version_count?: number }[]; categories?: LibraryCategory[] }) => {
        if (!live) return;
        if (!json.templates) { setState({ status: "error" }); return; }
        setState({
          status: "ready",
          templates: (json.templates ?? []).map((t) => ({ ...t, tags: (t.tags ?? []) as string[], versionCount: t.version_count ?? 0 })),
          categories: (json.categories ?? []) as LibraryCategory[],
        });
      })
      .catch(() => {
        if (live) setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { state, reload };
}
