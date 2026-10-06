"use client";

// Settings > Doc Sign > Lists: the shared lists of choices that forms use (states, countries, banks, MSIC business codes and the
// workspace's own). A table of the lists; opening one shows its items (list-detail.tsx). A list is archived, never deleted. The
// lists that come with Doc Sign keep every value they have; the workspace may relabel them and add to them.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCapability } from "@/hooks/use-can";
import { SignApiError } from "@/lib/sign/client/api";
import { listErrorKey } from "@/lib/sign/client/list-edit";
import { createList, loadLists } from "@/lib/sign/client/lists-api";
import type { OptionListSummary } from "@/lib/sign/lists/types";

import { ListDetail } from "./list-detail";
import { ListMetaDialog } from "./list-meta-dialog";
import { Loading } from "./shared";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; lists: OptionListSummary[] };

export function ListsSection() {
  const t = useTranslations("Sign.lists");
  const canEdit = useCapability("sign.settings");
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    let live = true;
    loadLists()
      .then((lists) => live && setLoad({ status: "ready", lists }))
      .catch(() => live && setLoad({ status: "error" }));
    return () => {
      live = false;
    };
  }, [round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);

  const lists = useMemo(() => (load.status === "ready" ? load.lists : []), [load]);
  const shown = useMemo(() => lists.filter((l) => showArchived || !l.archived), [lists, showArchived]);
  const archivedCount = lists.filter((l) => l.archived).length;

  async function create(values: { name: string; description: string }): Promise<string | null> {
    try {
      const list = await createList({ name: values.name, description: values.description || null });
      toast.success(t("created"));
      setCreating(false);
      reload();
      setOpen(list.key);
      return null;
    } catch (err) {
      return t(listErrorKey(err instanceof SignApiError ? err.code : null));
    }
  }

  if (open) {
    return (
      <ListDetail
        listKey={open}
        onBack={() => {
          setOpen(null);
          reload();
        }}
      />
    );
  }

  if (load.status === "loading") return <Loading label={t("loading")} />;
  if (load.status === "error") {
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p className="text-destructive">{t("loadFailed")}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[62ch] text-sm text-muted-foreground">{t("intro")}</p>
        <Button onClick={() => setCreating(true)} disabled={!canEdit}>
          <Plus aria-hidden />
          {t("new")}
        </Button>
      </div>

      {archivedCount > 0 ? (
        <label className="flex w-fit items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-4 accent-[var(--primary)]" />
          {t("showArchived", { count: archivedCount })}
        </label>
      ) : null}

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colName")}</TableHead>
              <TableHead>{t("colType")}</TableHead>
              <TableHead className="text-right">{t("colItems")}</TableHead>
              <TableHead className="text-right">{t("colVersion")}</TableHead>
              <TableHead className="text-right">{t("colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((l) => (
              <TableRow key={l.key} className={l.archived ? "opacity-70" : undefined}>
                <TableCell className="min-w-48">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">{l.name}</span>
                    {l.archived ? <Badge variant="outline">{t("archivedBadge")}</Badge> : null}
                  </div>
                  {l.description ? <p className="mt-0.5 text-xs text-muted-foreground">{l.description}</p> : null}
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{l.key}</p>
                </TableCell>
                <TableCell>
                  <Badge variant={l.is_system ? "secondary" : "outline"}>{l.is_system ? t("typeSystem") : t("typeOwn")}</Badge>
                  {l.kind === "msic" ? <Badge variant="outline" className="ml-1">{t("kindMsic")}</Badge> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{l.itemCount}</TableCell>
                <TableCell className="text-right tabular-nums">{l.version}</TableCell>
                <TableCell className="text-right">
                  <Button variant="outline" size="sm" onClick={() => setOpen(l.key)} aria-label={t("openList", { name: l.name })}>
                    {t("open")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">{t("footnote")}</p>

      <ListMetaDialog list={null} open={creating} onOpenChange={setCreating} onSubmit={create} />
    </div>
  );
}
