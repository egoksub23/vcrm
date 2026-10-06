"use client";

// One list, open: its items (searched and paged), what uses it, and everything an admin can do to it: add, relabel, reorder and
// archive items, rename the list, import a CSV, export a CSV, archive the list, and for a list that comes with Doc Sign put the
// wording back as shipped. Each change is saved at once (the server checks it again); nothing here is a draft. A list that comes
// with Doc Sign keeps every value: an item is archived (hidden from new forms), never deleted.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, Download, Pencil, Plus, RotateCcw, Search, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCapability } from "@/hooks/use-can";
import { SignApiError } from "@/lib/sign/client/api";
import { appendItem, hasRoom, listErrorKey, moveItemBy, paginate, replaceItem, setItemArchived } from "@/lib/sign/client/list-edit";
import { exportListUrl, loadList, patchList, resetList } from "@/lib/sign/client/lists-api";
import { searchItems } from "@/lib/sign/lists/logic";
import type { ListItem, ListResult } from "@/lib/sign/lists/types";
import type { SignLocale } from "@/lib/sign/types";

import { ListImportDialog } from "./list-import-dialog";
import { ListItemDialog } from "./list-item-dialog";
import { ListMetaDialog } from "./list-meta-dialog";
import { Loading } from "./shared";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ListResult };

const LANGS: readonly SignLocale[] = ["en", "ms", "zh", "ko"];

export function ListDetail({ listKey, onBack }: { listKey: string; onBack: () => void }) {
  const t = useTranslations("Sign.lists");
  const locale = useLocale();
  const canEdit = useCapability("sign.settings");
  const lang: SignLocale = (LANGS as readonly string[]).includes(locale) ? (locale as SignLocale) : "en";

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ListItem | "new" | null>(null);
  const [meta, setMeta] = useState(false);
  const [importing, setImporting] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let live = true;
    loadList(listKey)
      .then((data) => live && setLoad({ status: "ready", data }))
      .catch((err: unknown) => live && setLoad({ status: "error", message: t(listErrorKey(err instanceof SignApiError ? err.code : null)) }));
    return () => {
      live = false;
    };
  }, [listKey, round, t]);
  const reload = useCallback(() => setRound((n) => n + 1), []);

  const data = load.status === "ready" ? load.data : null;
  const list = data?.list;
  const items = useMemo(() => list?.items ?? [], [list]);
  const matches = useMemo(() => (query.trim() ? searchItems(items, query, lang, items.length) : items), [items, query, lang]);
  const shown = paginate(matches, page);
  const taken = useMemo(() => new Set(items.map((i) => i.value)), [items]);
  const searching = query.trim() !== "";

  /** Save a change to the list; resolves to a message to show, or null when it worked. */
  async function change(patch: Parameters<typeof patchList>[1], done?: string): Promise<string | null> {
    if (!list) return null;
    setBusy(true);
    try {
      const next = await patchList(list.key, patch);
      setLoad((l) => (l.status === "ready" ? { status: "ready", data: { ...l.data, list: next } } : l));
      if (done) toast.success(done);
      return null;
    } catch (err) {
      return t(listErrorKey(err instanceof SignApiError ? err.code : null));
    } finally {
      setBusy(false);
    }
  }

  const tell = (problem: string | null) => problem && toast.error(problem);

  if (load.status === "loading") return <Loading label={t("loading")} />;
  if (load.status === "error" || !list || !data) {
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p className="text-destructive">{load.status === "error" ? load.message : t("loadFailed")}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onBack}>
            {t("back")}
          </Button>
          <Button variant="outline" size="sm" onClick={reload}>
            {t("retry")}
          </Button>
        </div>
      </div>
    );
  }

  const msic = list.kind === "msic";
  const disabled = !canEdit || busy;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
          <ArrowLeft aria-hidden />
          {t("back")}
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold text-foreground">{list.name}</h3>
              <Badge variant={list.is_system ? "secondary" : "outline"}>{list.is_system ? t("typeSystem") : t("typeOwn")}</Badge>
              {list.archived ? <Badge variant="outline">{t("archivedBadge")}</Badge> : null}
              <span className="text-xs text-muted-foreground">{t("versionValue", { version: list.version })}</span>
            </div>
            {list.description ? <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{list.description}</p> : null}
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{list.key}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => setMeta(true)}>
              <Pencil aria-hidden />
              {t("rename")}
            </Button>
            <a href={exportListUrl(list.key)} download className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Download aria-hidden />
              {t("exportCsv")}
            </a>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => setImporting(true)}>
              <Upload aria-hidden />
              {t("importCsv")}
            </Button>
            {list.is_system ? (
              <Button variant="outline" size="sm" disabled={disabled} onClick={() => setResetting(true)}>
                <RotateCcw aria-hidden />
                {t("reset")}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => void change({ archived: !list.archived }, list.archived ? t("listRestored") : t("listArchived")).then(tell)}>
              {list.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
              {list.archived ? t("restoreList") : t("archiveList")}
            </Button>
          </div>
        </div>
        {list.is_system ? <p className="text-xs text-muted-foreground">{msic ? t("systemNoteMsic") : t("systemNote")}</p> : null}
      </div>

      <section aria-labelledby="list-used-by" className="rounded-lg border p-3">
        <h4 id="list-used-by" className="text-sm font-medium">
          {t("usedBy", { count: data.usedBy.length })}
        </h4>
        {data.usedBy.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{t("usedByNone")}</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {data.usedBy.map((u) => (
              <li key={u.id}>
                <Link href={`/sign/templates/${u.id}/form`} className="text-primary underline-offset-2 hover:underline">
                  {u.name}
                </Link>
                {u.status !== "active" ? <span className="ml-1 text-xs text-muted-foreground">({t(`status.${u.status}`)})</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{t("usedByHint")}</p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={query}
            placeholder={msic ? t("searchPlaceholderMsic") : t("searchPlaceholder")}
            aria-label={t("search")}
            className="pl-8"
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Button size="sm" disabled={disabled || !hasRoom(items)} onClick={() => setEditing("new")}>
          <Plus aria-hidden />
          {t("addItem")}
        </Button>
      </div>

      {shown.total === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{searching ? t("noMatches", { query: query.trim() }) : t("noItems")}</p>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colValue")}</TableHead>
                <TableHead>{t("colEnglish")}</TableHead>
                <TableHead>{t("colMalay")}</TableHead>
                <TableHead>{t("colOther")}</TableHead>
                <TableHead>{t("colGroup")}</TableHead>
                <TableHead className="text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.rows.map((item) => (
                <TableRow key={item.value} className={item.archived ? "opacity-60" : undefined}>
                  <TableCell className="font-mono text-xs">{item.value}</TableCell>
                  <TableCell className="min-w-40">
                    {item.label.en}
                    {item.archived ? <Badge variant="outline" className="ml-1.5">{t("archivedBadge")}</Badge> : null}
                  </TableCell>
                  <TableCell className="min-w-40">{item.label.ms ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{(["zh", "ko"] as const).filter((l) => item.label[l]).map((l) => t(`lang.${l}`)).join(" ") || "-"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.group ?? "-"}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {!msic && !searching ? (
                        <>
                          <Button variant="ghost" size="icon-sm" aria-label={t("moveUp", { name: item.label.en })} disabled={disabled || items[0]?.value === item.value} onClick={() => void change({ items: moveItemBy(items, item.value, -1) }).then(tell)}>
                            <ArrowUp aria-hidden />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label={t("moveDown", { name: item.label.en })} disabled={disabled || items[items.length - 1]?.value === item.value} onClick={() => void change({ items: moveItemBy(items, item.value, 1) }).then(tell)}>
                            <ArrowDown aria-hidden />
                          </Button>
                        </>
                      ) : null}
                      <Button variant="ghost" size="icon-sm" aria-label={t("editItem", { name: item.label.en })} disabled={disabled} onClick={() => setEditing(item)}>
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={item.archived ? t("restoreItem", { name: item.label.en }) : t("archiveItem", { name: item.label.en })}
                        disabled={disabled}
                        onClick={() => void change({ items: setItemArchived(items, item.value, !item.archived) }).then(tell)}
                      >
                        {item.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {shown.pages > 1 ? (
        <nav aria-label={t("pages")} className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{t("showing", { from: (shown.page - 1) * 50 + 1, to: Math.min(shown.page * 50, shown.total), total: shown.total })}</span>
          <span className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={shown.page <= 1} onClick={() => setPage(shown.page - 1)}>
              {t("previous")}
            </Button>
            <span className="tabular-nums">{t("pageOf", { page: shown.page, pages: shown.pages })}</span>
            <Button variant="outline" size="sm" disabled={shown.page >= shown.pages} onClick={() => setPage(shown.page + 1)}>
              {t("next")}
            </Button>
          </span>
        </nav>
      ) : (
        <p className="text-xs text-muted-foreground">{t("count", { count: shown.total })}</p>
      )}

      <ListItemDialog
        item={editing && editing !== "new" ? editing : null}
        kind={list.kind}
        taken={taken}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        onSubmit={async (item) => {
          const next = editing && editing !== "new" ? replaceItem(items, editing.value, item) : appendItem(items, item);
          const problem = await change({ items: next }, editing === "new" ? t("itemAdded") : t("itemSaved"));
          if (!problem) setEditing(null);
          return problem;
        }}
      />

      <ListMetaDialog
        list={meta ? list : null}
        open={meta}
        onOpenChange={setMeta}
        onSubmit={async (values) => {
          const problem = await change({ name: values.name, description: values.description || null }, t("listSaved"));
          if (!problem) setMeta(false);
          return problem;
        }}
      />

      <ListImportDialog
        list={list}
        open={importing}
        onOpenChange={setImporting}
        onImported={(next) => {
          toast.success(t("import.done"));
          if (next) setLoad((l) => (l.status === "ready" ? { status: "ready", data: { ...l.data, list: next } } : l));
          else reload();
        }}
      />

      <Dialog open={resetting} onOpenChange={setResetting}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("resetTitle", { name: list.name })}</DialogTitle>
            <DialogDescription>{t("resetBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetting(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                resetList(list.key)
                  .then((next) => {
                    setLoad((l) => (l.status === "ready" ? { status: "ready", data: { ...l.data, list: next } } : l));
                    toast.success(t("resetDone"));
                    setResetting(false);
                  })
                  .catch((err: unknown) => toast.error(t(listErrorKey(err instanceof SignApiError ? err.code : null))))
                  .finally(() => setBusy(false));
              }}
            >
              {t("resetConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
