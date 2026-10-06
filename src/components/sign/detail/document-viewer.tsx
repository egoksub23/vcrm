"use client";

// ============================================================
// Doc Sign, the detail screen: look at the document. The sealed copy once there is one (it already carries
// the answers and the certificate pages), otherwise the file as it was sent. Nothing is drawn over the pages.
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { documentFileUrl } from "@/lib/sign/client/api";
import { PdfPages, useElementWidth, usePdf } from "@/components/sign/pdf-pages";

interface Props {
  documentId: string;
  kind: "final" | "base";
  /** Changes when the file behind `kind` changes (for example when sealing finishes). */
  version: string;
}

export function DocumentViewer({ documentId, kind, version }: Props) {
  const t = useTranslations("Sign.detail");
  const [attempt, setAttempt] = useState(0);
  const [holder, width] = useElementWidth<HTMLDivElement>();
  const pdf = usePdf(documentFileUrl(documentId, kind), `${version}|${attempt}`);
  const pageWidth = Math.max(0, Math.min(width, 900));

  return (
    <div ref={holder} className="w-full rounded-xl bg-muted/40 p-2 sm:p-4">
      {pdf.status === "loading" && (
        <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("viewer.loading")}
        </div>
      )}
      {pdf.status === "error" && (
        <div className="flex h-48 flex-col items-center justify-center gap-3 text-center" role="alert">
          <p className="text-sm text-foreground">{t(pdf.code === "unreadable" ? "viewer.unreadable" : "viewer.failed")}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {t("viewer.retry")}
          </Button>
        </div>
      )}
      {pdf.status === "ready" && pageWidth > 0 && <PdfPages doc={pdf.doc} pages={pdf.pages} width={Math.max(0, pageWidth - 16)} pageLabel={(i, total) => t("viewer.page", { page: i + 1, total })} />}
    </div>
  );
}
