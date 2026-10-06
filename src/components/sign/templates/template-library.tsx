"use client";

// Sign > Templates: the library of prepared documents. Read with the browser client through row level security
// (menu.sign); changes go through the routes (sign.templates), which check the rules. A template is never
// edited here: the editor (/sign/templates/<id>) is its own full-screen page.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Archive, ArchiveRestore, CheckCircle2, Copy, FilePlus2, Loader2, Search, Trash2 } from "lucide-react";

import { Field, Loading, NativeSelect, useAdminErrorText } from "@/components/settings/sign/shared";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCapability } from "@/hooks/use-can";
import { signRequest } from "@/lib/sign/client/api";
import {
  EMPTY_LIBRARY_FILTERS,
  TEMPLATE_STATUSES,
  filterTemplates,
  isLibraryFiltered,
  newDocumentFromTemplateHref,
  templateEditorHref,
  templateStatusBadgeClass,
  templateStatusKey,
  type LibraryFilters,
  type LibraryTemplate,
  type TemplateStatus,
} from "@/lib/sign/client/template-library";
import { cn } from "@/lib/utils";

import { NewTemplateDialog } from "./new-template-dialog";
import { useTemplateLibrary, type LibraryCategory } from "./use-template-library";

const NO_TEMPLATES: LibraryTemplate[] = [];
const NO_CATEGORIES: LibraryCategory[] = [];

export function TemplateLibrary() {
  const t = useTranslations("Sign.admin.library");
  const format = useFormatter();
  const errorText = useAdminErrorText();
  const canManage = useCapability("sign.templates");
  const canSend = useCapability("sign.send");

  const { state, reload } = useTemplateLibrary();
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<LibraryTemplate | null>(null);

  const templates = state.status === "ready" ? state.templates : NO_TEMPLATES;
  const categories = state.status === "ready" ? state.categories : NO_CATEGORIES;
  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const shown = useMemo(() => filterTemplates(templates, filters), [templates, filters]);

  const run = async (id: string, action: () => Promise<string | null>) => {
    setBusy(id);
    try {
      const done = await action();
      if (done) toast.success(done);
      reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const duplicate = (row: LibraryTemplate) =>
    run(row.id, async () => {
      await signRequest(`/api/sign/templates/${row.id}/duplicate`, { method: "POST", json: {} });
      return t("duplicated", { name: row.name });
    });

  const setStatus = (row: LibraryTemplate, status: TemplateStatus, message: string) =>
    run(row.id, async () => {
      await signRequest(`/api/sign/templates/${row.id}`, { method: "PATCH", json: { status } });
      return message;
    });

  const remove = (row: LibraryTemplate) =>
    run(row.id, async () => {
      await signRequest(`/api/sign/templates/${row.id}`, { method: "DELETE" });
      setToDelete(null);
      return t("deleted", { name: row.name });
    });

  if (state.status === "loading") return <Loading label={t("loading")} />;
  if (state.status === "error") {
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p className="text-destructive">{t("loadFailed")}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  const filtered = isLibraryFiltered(filters);
  const categoryOptions = [
    { value: "all", label: t("allCategories") },
    { value: "none", label: t("noCategory") },
    ...categories.filter((c) => !c.archived || templates.some((x) => x.category_id === c.id)).map((c) => ({ value: c.id, label: c.archived ? t("archivedCategory", { name: c.name }) : c.name })),
  ];
  const statusOptions = [{ value: "all", label: t("allStatuses") }, ...TEMPLATE_STATUSES.map((s) => ({ value: s, label: t(templateStatusKey(s)) }))];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <label htmlFor="template-search" className="sr-only">
            {t("search")}
          </label>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="template-search" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder={t("search")} className="h-9 pl-8" />
        </div>
        <Field id="template-category" label={t("category")} className="min-w-40">
          <NativeSelect id="template-category" value={filters.category} onChange={(category) => setFilters({ ...filters, category })} options={categoryOptions} />
        </Field>
        <Field id="template-status" label={t("status")} className="min-w-36">
          <NativeSelect id="template-status" value={filters.status} onChange={(status) => setFilters({ ...filters, status: status as LibraryFilters["status"] })} options={statusOptions} />
        </Field>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_LIBRARY_FILTERS)}>
            {t("clearFilters")}
          </Button>
        ) : null}
        <div className="ml-auto">
          <Button onClick={() => setCreating(true)} disabled={!canManage} title={canManage ? undefined : t("needsPermission")}>
            <FilePlus2 aria-hidden />
            {t("newTemplate")}
          </Button>
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">{t("emptyBody")}</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colCategory")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colVersions")}</TableHead>
                <TableHead>{t("colUpdated")}</TableHead>
                <TableHead className="text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <TableRow key={row.id} className={cn(row.status === "archived" && "opacity-70")}>
                  <TableCell className="min-w-48 whitespace-normal">
                    <Link href={templateEditorHref(row.id)} className="font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline">
                      {row.name}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {row.addon_key ? <Badge variant="secondary">{t("addonBadge")}</Badge> : null}
                      {row.addon_key && row.customised ? <Badge variant="outline">{t("customisedBadge")}</Badge> : null}
                      {row.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                    {row.description ? <p className="mt-1 text-xs text-muted-foreground">{row.description}</p> : null}
                  </TableCell>
                  <TableCell>{row.category_id ? (categoryName.get(row.category_id) ?? t("noCategory")) : t("noCategory")}</TableCell>
                  <TableCell>
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", templateStatusBadgeClass(row.status))}>{t(templateStatusKey(row.status))}</span>
                  </TableCell>
                  <TableCell>{t("versions", { count: row.versionCount })}</TableCell>
                  <TableCell>{format.dateTime(new Date(row.updated_at), { dateStyle: "medium" })}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Link href={templateEditorHref(row.id)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                        {canManage ? t("openEditor") : t("view")}
                      </Link>
                      {row.status === "active" && canSend ? (
                        <Link href={newDocumentFromTemplateHref(row.id)} className={buttonVariants({ size: "sm" })}>
                          {t("useTemplate")}
                        </Link>
                      ) : null}
                      {row.status === "draft" && canManage ? (
                        <Button size="sm" variant="secondary" disabled={busy === row.id} onClick={() => void setStatus(row, "active", t("madeActive", { name: row.name }))}>
                          <CheckCircle2 aria-hidden />
                          {t("makeActive")}
                        </Button>
                      ) : null}
                      {canManage ? (
                        <>
                          <Button variant="ghost" size="icon-sm" aria-label={t("duplicate", { name: row.name })} disabled={busy === row.id} onClick={() => void duplicate(row)}>
                            {busy === row.id ? <Loader2 className="animate-spin" aria-hidden /> : <Copy aria-hidden />}
                          </Button>
                          {row.status === "archived" ? (
                            <Button variant="ghost" size="icon-sm" aria-label={t("restore", { name: row.name })} disabled={busy === row.id} onClick={() => void setStatus(row, "draft", t("restored", { name: row.name }))}>
                              <ArchiveRestore aria-hidden />
                            </Button>
                          ) : (
                            <Button variant="ghost" size="icon-sm" aria-label={t("archive", { name: row.name })} disabled={busy === row.id} onClick={() => void setStatus(row, "archived", t("archived", { name: row.name }))}>
                              <Archive aria-hidden />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon-sm" aria-label={t("delete", { name: row.name })} disabled={busy === row.id} onClick={() => setToDelete(row)}>
                            <Trash2 aria-hidden />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t("footnote")}</p>

      <NewTemplateDialog open={creating} onOpenChange={setCreating} categories={categories} />

      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { name: toDelete?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={busy !== null}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => toDelete && void remove(toDelete)}>
              {busy !== null ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
