"use client";

// Settings > Doc Sign > Categories: a list with each category's presets, create, edit, archive and restore,
// and reorder. Read and written with the browser client under row level security (sign.settings writes).
// A category is never deleted (documents keep their label), only archived. Its key is made from its name
// when it is created and never changes.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArchiveRestore, ArrowDown, ArrowUp, Archive, Pencil, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { formatReminderDays, keyFromName, reorderPositions, sortCategories, type CategoryValues, type SignCategoryRow } from "@/lib/sign/client/admin-settings";
import { createClient } from "@/lib/supabase/client";

import { CategoryDialog } from "./category-dialog";
import { Loading } from "./shared";

const NO_ROWS: SignCategoryRow[] = [];

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; rows: SignCategoryRow[] };

export function CategoriesSection() {
  const t = useTranslations("Sign.admin.categories");
  const { accountId } = useAuth();
  const canEdit = useCapability("sign.settings");

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<SignCategoryRow | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void createClient()
      .from("sign_categories")
      .select("*")
      .order("position", { ascending: true })
      .then(({ data, error }) => {
        if (!live) return;
        setLoad(error ? { status: "error" } : { status: "ready", rows: sortCategories((data ?? []) as SignCategoryRow[]) });
      });
    return () => {
      live = false;
    };
  }, [round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);

  const rows = load.status === "ready" ? load.rows : NO_ROWS;
  const shown = useMemo(() => rows.filter((r) => showArchived || !r.archived), [rows, showArchived]);
  const archivedCount = rows.filter((r) => r.archived).length;

  const submit = async (values: CategoryValues): Promise<string | null> => {
    const supabase = createClient();
    if (editing && editing !== "new") {
      // the key is never sent: it is fixed when the category is created
      const { error } = await supabase.from("sign_categories").update(values).eq("id", editing.id);
      if (error) return t("saveFailed");
      toast.success(t("saved"));
    } else {
      if (!accountId) return t("saveFailed");
      const key = keyFromName(values.name, rows.map((r) => r.key));
      const position = rows.reduce((m, r) => Math.max(m, r.position), 0) + 1;
      const { error } = await supabase.from("sign_categories").insert({ ...values, account_id: accountId, key, position });
      if (error) return error.code === "23505" ? t("duplicateKey") : t("saveFailed");
      toast.success(t("created"));
    }
    setEditing(null);
    reload();
    return null;
  };

  const setArchived = async (row: SignCategoryRow, archived: boolean) => {
    setBusy(row.id);
    const { error } = await createClient().from("sign_categories").update({ archived }).eq("id", row.id);
    setBusy(null);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    toast.success(archived ? t("archived") : t("restored"));
    reload();
  };

  const move = async (row: SignCategoryRow, dir: -1 | 1) => {
    // order is among the categories shown, so a hidden archived one never makes a move look like nothing happened
    const changes = reorderPositions(shown, row.id, dir);
    if (changes.length === 0) return;
    setBusy(row.id);
    const supabase = createClient();
    const results = await Promise.all(changes.map((c) => supabase.from("sign_categories").update({ position: c.position }).eq("id", c.id)));
    setBusy(null);
    if (results.some((r) => r.error)) toast.error(t("saveFailed"));
    reload();
  };

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

  const days = (n: number | null) => (n == null ? t("workspaceDefault") : t("daysValue", { count: n }));
  const onOff = (v: boolean) => (v ? t("on") : t("off"));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[62ch] text-sm text-muted-foreground">{t("intro")}</p>
        <Button onClick={() => setEditing("new")} disabled={!canEdit}>
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

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colExpires")}</TableHead>
                <TableHead>{t("colReminders")}</TableHead>
                <TableHead>{t("colCode")}</TableHead>
                <TableHead>{t("colOrder")}</TableHead>
                <TableHead>{t("colRetention")}</TableHead>
                <TableHead className="text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row, i) => (
                <TableRow key={row.id} className={row.archived ? "opacity-70" : undefined}>
                  <TableCell className="min-w-40">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">{row.name}</span>
                      {row.addon_key ? <Badge variant="secondary">{t("addonBadge")}</Badge> : null}
                      {row.archived ? <Badge variant="outline">{t("archivedBadge")}</Badge> : null}
                    </div>
                    {row.description ? <p className="mt-0.5 text-xs text-muted-foreground">{row.description}</p> : null}
                  </TableCell>
                  <TableCell>{days(row.expiry_days)}</TableCell>
                  <TableCell>{row.reminder_days && row.reminder_days.length > 0 ? formatReminderDays(row.reminder_days) : t("workspaceDefault")}</TableCell>
                  <TableCell>{onOff(row.code_required)}</TableCell>
                  <TableCell>{onOff(row.sign_in_order)}</TableCell>
                  <TableCell>{row.retention_years == null ? t("workspaceDefault") : t("yearsValue", { count: row.retention_years })}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={t("moveUp", { name: row.name })} disabled={!canEdit || busy !== null || i === 0} onClick={() => void move(row, -1)}>
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={t("moveDown", { name: row.name })} disabled={!canEdit || busy !== null || i === shown.length - 1} onClick={() => void move(row, 1)}>
                        <ArrowDown aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={t("edit", { name: row.name })} disabled={!canEdit} onClick={() => setEditing(row)}>
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={row.archived ? t("restore", { name: row.name }) : t("archive", { name: row.name })}
                        disabled={!canEdit || busy === row.id}
                        onClick={() => void setArchived(row, !row.archived)}
                      >
                        {row.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t("footnote")}</p>

      <CategoryDialog category={editing && editing !== "new" ? editing : null} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} onSubmit={submit} />
    </div>
  );
}
