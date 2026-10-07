"use client";

// ============================================================
// Doc Sign, document collections: the two halves of choosing the documents. `CollectionPicker` adds to the list (many files at once, or one at a
// time, and templates ticked from the workspace's); `CollectionList` shows the ONE ordered list of everything chosen, with each document's title
// (editable), up and down, drag to reorder, and remove. The list itself is the pure functions of lib/sign/client/collection-list.ts; these are
// only the screen around them. Used by the builder on the New document page and by the draft's "Add a document".
// ============================================================

import { useMemo, useState, type DragEvent } from "react";
import Link from "next/link";
import { AlertCircle, ArrowDown, ArrowUp, FileText, GripVertical, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActiveTemplates } from "@/hooks/use-sign-templates";
import { addFiles, defaultTitle, hasTemplate, moveBy, moveTo, removeItem, retitle, toggleTemplate, type CollectionItem, type RejectedFile } from "@/lib/sign/client/collection-list";
import { errorKey } from "@/lib/sign/client/errors";
import { formatBytes } from "@/lib/sign/client/upload";
import { cn } from "@/lib/utils";

import { FilesDrop } from "../send/files-drop";

type Items = CollectionItem<File>[];

interface PickerProps {
  items: Items;
  onItems: (next: Items) => void;
  /** How many documents the list may hold in all. */
  max: number;
  disabled?: boolean;
}

interface Notice {
  overflow: number;
  added: number;
  rejected: RejectedFile[];
}

/** Add files (many at once, or one by one, any time) and tick templates. What is added goes to the end of the list. */
export function CollectionPicker({ items, onItems, max, disabled }: PickerProps) {
  const t = useTranslations("Sign.send.collection.files");
  const tNew = useTranslations("Sign.send.new");
  const tErr = useTranslations("Sign.send");
  const { templates, loading, error } = useActiveTemplates();
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? "").toLowerCase().includes(q));
  }, [templates, query]);

  const onFiles = (files: File[]) => {
    const result = addFiles(items, files, max);
    onItems(result.items);
    setNotice(result.overflow > 0 || result.rejected.length > 0 ? { overflow: result.overflow, added: result.added, rejected: result.rejected } : null);
  };

  const toggle = (id: string, name: string) => {
    const result = toggleTemplate(items, { id, name }, max);
    setNotice(result.full ? { overflow: 1, added: 0, rejected: [] } : null);
    onItems(result.items);
  };

  const full = items.length >= max;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">{t("heading")}</p>
        <FilesDrop onFiles={onFiles} disabled={disabled} room={max - items.length} />
        {notice ? (
          <div role="status" className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
            {notice.overflow > 0 ? (
              <p className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
                {notice.added > 0 ? t("overflowSome", { added: notice.added, skipped: notice.overflow, max }) : t("overflowNone", { max })}
              </p>
            ) : null}
            {notice.rejected.map((r, i) => (
              <p key={`${r.name}-${i}`} className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
                {t("rejected", { name: r.name, reason: tErr(errorKey(r.code)) })}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-sm font-medium text-foreground">{t("templatesHeading")}</p>
        {loading ? (
          <div className="space-y-2" role="status" aria-label={tNew("loadingTemplates")}>
            {[0, 1].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-muted/40" />
            ))}
          </div>
        ) : error ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="size-4" aria-hidden />
            {tNew("templatesFailed")}
          </p>
        ) : templates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            <p>{tNew("noTemplates")}</p>
            <Link href="/sign/templates" className="mt-1 inline-block text-primary underline-offset-4 hover:underline">
              {tNew("goToTemplates")}
            </Link>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="search" aria-label={tNew("searchTemplates")} placeholder={tNew("searchTemplates")} className="h-9 pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {shown.length === 0 ? <p className="text-sm text-muted-foreground">{tNew("noTemplateMatch")}</p> : null}
            <ul className="max-h-72 space-y-1.5 overflow-y-auto" aria-label={t("templatesHeading")}>
              {shown.map((tpl) => {
                const on = hasTemplate(items, tpl.id);
                const blocked = !on && full;
                return (
                  <li key={tpl.id}>
                    <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", on ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40", blocked && "cursor-not-allowed opacity-50")}>
                      <input type="checkbox" className="mt-1 size-4" checked={on} disabled={blocked || disabled} onChange={() => toggle(tpl.id, tpl.name)} />
                      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{tpl.name}</span>
                        {tpl.description ? <span className="block truncate text-xs text-muted-foreground">{tpl.description}</span> : null}
                        <span className="block text-xs text-muted-foreground">{tpl.mode === "form" ? tNew("templateFactsForm", { roles: tpl.roles }) : tNew("templateFacts", { pages: tpl.pages, roles: tpl.roles })}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

interface ListProps {
  items: Items;
  onItems: (next: Items) => void;
  disabled?: boolean;
}

/** The documents chosen, in the order they will be signed: a title the sender can change, up and down, drag, and remove. */
export function CollectionList({ items, onItems, disabled }: ListProps) {
  const t = useTranslations("Sign.send.collection.list");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const drop = (targetKey: string) => {
    const from = items.findIndex((i) => i.key === dragKey);
    const to = items.findIndex((i) => i.key === targetKey);
    if (from >= 0 && to >= 0 && from !== to) onItems(moveTo(items, from, to));
    setDragKey(null);
    setOverKey(null);
  };

  return (
    <ol className="space-y-1.5" aria-label={t("label")}>
      {items.map((item, i) => {
        const name = defaultTitle(item);
        const label = item.title.trim() || name;
        return (
          <li
            key={item.key}
            draggable={!disabled}
            onDragStart={(e: DragEvent) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", item.key);
              setDragKey(item.key);
            }}
            onDragOver={(e: DragEvent) => {
              if (!dragKey) return;
              e.preventDefault();
              if (overKey !== item.key) setOverKey(item.key);
            }}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              drop(item.key);
            }}
            onDragEnd={() => {
              setDragKey(null);
              setOverKey(null);
            }}
            data-kind={item.kind}
            className={cn("flex items-center gap-2 rounded-lg border bg-background px-2 py-2 text-sm", dragKey === item.key && "opacity-50", dragKey && overKey === item.key && dragKey !== item.key ? "border-primary" : "border-border")}
          >
            <GripVertical className={cn("size-4 shrink-0 text-muted-foreground", !disabled && "cursor-grab")} aria-hidden />
            <span className="w-5 shrink-0 text-muted-foreground tabular-nums">{i + 1}.</span>
            <div className="min-w-0 flex-1">
              <Input aria-label={t("titleLabel", { n: i + 1 })} className="h-8" maxLength={200} value={item.title} placeholder={name} disabled={disabled} onChange={(e) => onItems(retitle(items, item.key, e.target.value))} />
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.kind === "file" ? t("kindFile", { size: formatBytes(item.file.size), name: item.file.name }) : t("kindTemplate")}</p>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveUp", { title: label })} disabled={disabled || i === 0} onClick={() => onItems(moveBy(items, i, -1))}>
              <ArrowUp aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveDown", { title: label })} disabled={disabled || i === items.length - 1} onClick={() => onItems(moveBy(items, i, 1))}>
              <ArrowDown aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("remove", { title: label })} disabled={disabled} onClick={() => onItems(removeItem(items, item.key))}>
              <X aria-hidden />
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
