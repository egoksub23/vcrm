"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, FileText, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { useSignCategories } from "@/hooks/use-sign-categories";
import type { ActiveTemplate } from "@/hooks/use-sign-templates";
import { cn } from "@/lib/utils";

interface Props {
  templates: readonly ActiveTemplate[];
  loading: boolean;
  error: boolean;
  selectedId: string | null;
  onSelect: (template: ActiveTemplate) => void;
}

/** The active templates, grouped by category, with a search box. One can be chosen (a radio group). */
export function TemplatePicker({ templates, loading, error, selectedId, onSelect }: Props) {
  const t = useTranslations("Sign.send.new");
  const { categories } = useSignCategories();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = templates.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? "").toLowerCase().includes(q));
    const byCategory = new Map<string, ActiveTemplate[]>();
    for (const tpl of shown) {
      const k = tpl.category_id ?? "";
      byCategory.set(k, [...(byCategory.get(k) ?? []), tpl]);
    }
    const ordered = categories.filter((c) => byCategory.has(c.id)).map((c) => ({ id: c.id, name: c.name, items: byCategory.get(c.id) ?? [] }));
    // a template whose category is not (or no longer) listed is shown with the ones that have none
    const known = new Set(categories.map((c) => c.id));
    const strays = [...byCategory.entries()].filter(([k]) => k !== "" && !known.has(k)).flatMap(([, v]) => v);
    const rest = [...(byCategory.get("") ?? []), ...strays];
    return rest.length ? [...ordered, { id: "", name: "", items: rest }] : ordered;
  }, [templates, categories, query]);

  if (loading) {
    return (
      <div className="space-y-2" role="status" aria-label={t("loadingTemplates")}>
        {[0, 1].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-muted/40" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="size-4" aria-hidden />
        {t("templatesFailed")}
      </p>
    );
  }
  if (templates.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
        <p>{t("noTemplates")}</p>
        <Link href="/sign/templates" className="mt-1 inline-block text-primary underline-offset-4 hover:underline">
          {t("goToTemplates")}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input type="search" aria-label={t("searchTemplates")} placeholder={t("searchTemplates")} className="h-9 pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {groups.length === 0 ? <p className="text-sm text-muted-foreground">{t("noTemplateMatch")}</p> : null}
      <div role="radiogroup" aria-label={t("templatesLabel")} className="space-y-4">
        {groups.map((g) => (
          <div key={g.id || "none"} className="space-y-1.5">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.id ? g.name : t("noCategoryGroup")}</p>
            {g.items.map((tpl) => {
              const checked = tpl.id === selectedId;
              return (
                <label
                  key={tpl.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    checked ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                  )}
                >
                  <input type="radio" name="template" className="mt-1 size-4" checked={checked} onChange={() => onSelect(tpl)} />
                  <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{tpl.name}</span>
                    {tpl.description ? <span className="block truncate text-xs text-muted-foreground">{tpl.description}</span> : null}
                    <span className="block text-xs text-muted-foreground">{tpl.mode === "form" ? t("templateFactsForm", { roles: tpl.roles }) : t("templateFacts", { pages: tpl.pages, roles: tpl.roles })}</span>
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
