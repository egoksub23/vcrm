"use client";

// ============================================================
// Secure Sign, step 3: the DOCUMENT NAVIGATOR beside the scroll. Every document with its number, title, pages and blocks (a small warning when a
// person who must sign has no block on it); the document in view is open and shows its pages as thumbnails (drawn only when they come into the
// navigator's own view, at a small scale), the others are closed. A click on a document goes to its first page, a click on a thumbnail to that
// page, and the document and page in view follow the scroll. On a phone the navigator is a "Jump to document" menu.
// ============================================================

import { AlertTriangle, ClipboardList, FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { NativeSelect } from "@/components/sign/editor/form-bits";
import { PdfThumb, type PdfPageSize } from "@/components/sign/pdf-pages";
import { pageSizesOf, peopleWithoutBlock, type Position } from "@/lib/sign/client/blocks-nav";
import type { DocCover } from "@/lib/sign/client/process";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { cn } from "@/lib/utils";

export interface NavigatorProps {
  covers: readonly DocCover[];
  /** The blocks of each document as they are on screen (undefined while it is being read). */
  fieldsOf: (id: string) => readonly PlacedField[] | undefined;
  /** The real page sizes of the documents whose files have been opened. */
  sizes: Readonly<Record<string, PdfPageSize[]>>;
  /** The documents whose files are open now: their pages can be drawn as thumbnails. */
  opened: Readonly<Record<string, PDFDocumentProxy>>;
  current: Position;
  onJumpDoc: (doc: number) => void;
  onJumpPage: (doc: number, page: number) => void;
  /** A name for a person who has none yet ("Person 2"). */
  personName: (index: number) => string;
}

const THUMB_WIDTH = 84;

function useCounts(cover: DocCover, fields: readonly PlacedField[] | undefined) {
  const pageCount = cover.doc.pageCount ?? 0;
  const blocksOnPage = useMemo(() => {
    const out = new Map<number, number>();
    for (const f of fields ?? []) out.set(f.page, (out.get(f.page) ?? 0) + 1);
    return out;
  }, [fields]);
  return { pageCount, blocksOnPage };
}

function Missing({ cover, personName }: { cover: DocCover; personName: (i: number) => string }) {
  const t = useTranslations("Sign.process.multi");
  const names = peopleWithoutBlock(cover).map((key) => {
    const i = cover.people.findIndex((p) => p.key === key);
    return cover.people[i]?.name || personName(i);
  });
  if (names.length === 0 || cover.state === "ready") return null;
  const text = t("missingFor", { names: names.join(", "), count: names.length });
  return (
    <span data-missing={names.length} title={text} className="inline-flex shrink-0 items-center text-[light-dark(#b45309,#fcd34d)]">
      <AlertTriangle className="size-3.5" aria-hidden />
      <span className="sr-only">{text}</span>
    </span>
  );
}

function DocItem({ cover, index, total, isCurrent, page, props, scrollRoot }: { cover: DocCover; index: number; total: number; isCurrent: boolean; page: number; props: NavigatorProps; scrollRoot: HTMLElement | null }) {
  const t = useTranslations("Sign.process.multi");
  const tb = useTranslations("Sign.process.blocks");
  const fields = props.fieldsOf(cover.doc.id);
  const known = props.sizes[cover.doc.id];
  const { pageCount, blocksOnPage } = useCounts(cover, fields);
  const sizes = pageSizesOf(known, pageCount);
  const pdf = props.opened[cover.doc.id] ?? null;
  const parts = Object.values(cover.doc.partCounts).reduce((n, c) => n + c, 0);
  const pagesText = cover.formOnly ? t("formLine", { parts }) : tb("pages", { count: known?.length || pageCount });
  const blocksText = cover.formOnly ? "" : cover.blocks > 0 ? tb("blockCount", { count: cover.blocks }) : t("noBlocksYet");
  const Icon = cover.formOnly ? ClipboardList : FileText;
  return (
    <li data-nav-doc={cover.doc.id} data-current={isCurrent ? "true" : "false"} className={cn("rounded-lg border", isCurrent ? "border-primary/40 bg-muted/60" : "border-transparent")}>
      <button
        type="button"
        aria-current={isCurrent ? "true" : undefined}
        aria-expanded={isCurrent && !cover.formOnly && sizes.length > 0}
        onClick={() => props.onJumpDoc(index)}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            <span className="tabular-nums text-muted-foreground">{index + 1}.</span> {cover.doc.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {pagesText}
            {blocksText ? ` · ${blocksText}` : ""}
          </span>
        </span>
        <Missing cover={cover} personName={props.personName} />
        <span className="sr-only">{t("docOf", { n: index + 1, total })}</span>
      </button>
      {isCurrent && !cover.formOnly && sizes.length > 0 ? (
        <ol className="grid grid-cols-2 gap-x-2 gap-y-2 px-2 pt-1 pb-2" aria-label={t("pagesOf", { title: cover.doc.title })}>
          {sizes.map((size, p) => {
            const n = blocksOnPage.get(p) ?? 0;
            const here = p === page;
            return (
              <li key={p} className="flex justify-center">
                <button
                  type="button"
                  aria-current={here ? "page" : undefined}
                  aria-label={t("pageThumb", { page: p + 1, count: sizes.length, blocks: n })}
                  onClick={() => props.onJumpPage(index, p)}
                  className={cn("flex flex-col items-center gap-0.5 rounded-md p-1 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50", here && "bg-primary/10")}
                >
                  <PdfThumb doc={pdf} index={p} size={size} width={THUMB_WIDTH} scrollRoot={scrollRoot} className={cn("rounded-[2px]", here && "ring-2 ring-primary")}>
                    {n > 0 ? <span data-page-blocks={n} className="absolute right-0.5 bottom-0.5 rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground tabular-nums">{n}</span> : null}
                  </PdfThumb>
                  <span className="text-[11px] text-muted-foreground tabular-nums" aria-hidden>
                    {p + 1}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </li>
  );
}

/** The column on the right: the documents, the one in view open with its pages. */
export function DocNavigator(props: NavigatorProps) {
  const t = useTranslations("Sign.process.multi");
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const { current } = props;

  // keep the page in view in the navigator's own scroll (without moving anything else on the screen)
  useEffect(() => {
    if (!root) return;
    const el = root.querySelector<HTMLElement>('[aria-current="page"]') ?? root.querySelector<HTMLElement>('[data-current="true"]');
    if (!el) return;
    const box = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top + 4) root.scrollBy({ top: r.top - (box.top + 4) });
    else if (r.bottom > box.bottom - 4) root.scrollBy({ top: r.bottom - (box.bottom - 4) });
  }, [root, current.doc, current.page]);

  return (
    <nav ref={setRoot} aria-label={t("navigatorLabel")} data-doc-navigator className="h-full overflow-y-auto p-2">
      <ol className="space-y-1">
        {props.covers.map((c, i) => (
          <DocItem key={c.doc.id} cover={c} index={i} total={props.covers.length} isCurrent={i === current.doc} page={current.page} props={props} scrollRoot={root} />
        ))}
      </ol>
    </nav>
  );
}

/** The phone's navigator: a menu to jump to a document. */
export function DocJumpSelect({ covers, current, onJumpDoc }: Pick<NavigatorProps, "covers" | "current" | "onJumpDoc">) {
  const t = useTranslations("Sign.process.multi");
  const tb = useTranslations("Sign.process.blocks");
  return (
    <div className="flex min-w-0 items-center gap-2" data-doc-jump>
      <label htmlFor="blocks-jump-doc" className="sr-only">
        {t("jumpLabel")}
      </label>
      <NativeSelect id="blocks-jump-doc" className="h-8 min-w-0 flex-1" value={current.doc} onChange={(e) => onJumpDoc(Number(e.target.value))}>
        {covers.map((c, i) => (
          <option key={c.doc.id} value={i}>
            {`${i + 1}. ${c.doc.title}${c.formOnly ? "" : ` (${tb("pages", { count: c.doc.pageCount ?? 0 })})`}`}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
