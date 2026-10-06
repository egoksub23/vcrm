"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle, Download, Layers, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { downloadFile } from "@/components/sign/detail/download";
import { Button, buttonVariants } from "@/components/ui/button";
import { SignApiError } from "@/lib/sign/client/api";
import { bulkErrorKey } from "@/lib/sign/client/bulk";
import { exportQuery, type ExportFilters } from "@/lib/sign/export/documents";
import { cn } from "@/lib/utils";

/**
 * Above the documents list: "Export CSV" (the documents the filters on screen ask for, as a spreadsheet file) and
 * "Bulk send" (one template to a list of people).
 */
export function ListActions({ filters, canSend }: { filters: Pick<ExportFilters, "group" | "category" | "search">; canSend: boolean }) {
  const t = useTranslations("Sign.bulk");
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const exportCsv = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      await downloadFile(`/api/sign/documents/export${exportQuery(filters)}`, "signing-documents.csv");
    } catch (err) {
      setErrorKey(bulkErrorKey(err instanceof SignApiError ? err.code : "request_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {errorKey ? (
        <p role="alert" className="mr-auto flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          {t(errorKey)}
        </p>
      ) : null}
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void exportCsv()}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
        {t("list.exportCsv")}
      </Button>
      {canSend ? (
        <Link href="/sign/bulk" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          <Layers aria-hidden />
          {t("list.bulkSend")}
        </Link>
      ) : null}
    </div>
  );
}
