"use client";

import { useState } from "react";
import { AlertCircle, FileArchive, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { SignApiError } from "@/lib/sign/client/api";
import { bulkErrorKey } from "@/lib/sign/client/bulk";
import { downloadZip, type ZipDownloaded } from "./zip-download";

interface Props {
  ids: readonly string[];
  max: number;
  onClear: () => void;
}

/**
 * Shown while documents are ticked: how many, and the actions that take them together. Today that is the zip of their
 * signed files (only completed documents have one; the rest are left out and the sender is told how many).
 */
export function SelectionBar({ ids, max, onClear }: Props) {
  const t = useTranslations("Sign.bulk");
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [result, setResult] = useState<ZipDownloaded | null>(null);

  const zip = async () => {
    setBusy(true);
    setErrorKey(null);
    setResult(null);
    try {
      setResult(await downloadZip(ids));
    } catch (err) {
      setErrorKey(bulkErrorKey(err instanceof SignApiError ? err.code : "request_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="region" aria-label={t("list.selectionBar")} className="sticky top-2 z-10 space-y-1.5 rounded-xl border border-primary/30 bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-foreground" aria-live="polite">
          {t("list.selected", { count: ids.length })}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void zip()}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <FileArchive aria-hidden />}
            {t("list.downloadZip")}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClear}>
            {t("list.clearSelection")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{ids.length >= max ? t("list.zipFull", { max }) : t("list.zipHint", { max })}</p>
      {result ? (
        <p role="status" className="text-xs text-foreground">
          {result.skipped > 0 ? t("list.zipDoneSkipped", { included: result.included, skipped: result.skipped }) : t("list.zipDone", { included: result.included })}
        </p>
      ) : null}
      {errorKey ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t(errorKey)}
        </p>
      ) : null}
    </div>
  );
}
