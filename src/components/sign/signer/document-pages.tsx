"use client";

// ============================================================
// Doc Sign, signing page: the pages of the document, fitted to the screen's width, with whatever the
// caller draws over each page. Zooming makes the pages wider than the screen and the area scrolls
// sideways inside itself; the page as a whole never does. Pinching the screen works as usual.
// ============================================================

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { PdfPages, useElementWidth, usePdf } from "@/components/sign/pdf-pages";
import { cn } from "@/lib/utils";

interface DocumentPagesProps {
  url: string;
  /** 1 is the width of the screen. */
  zoom?: number;
  overlay?: (index: number, onScreen: { width: number; height: number }) => ReactNode;
  className?: string;
}

export function DocumentPages({ url, zoom = 1, overlay, className }: DocumentPagesProps) {
  const t = useTranslations("Sign.signer");
  const [version, setVersion] = useState(0);
  const pdf = usePdf(url, version);
  const [holder, width] = useElementWidth<HTMLDivElement>();
  const pageWidth = Math.max(240, Math.floor(width * zoom));

  return (
    <div ref={holder} className={cn("w-full", className)}>
      {pdf.status === "error" ? (
        <div role="alert" className="space-y-3 rounded-xl border bg-card p-4 text-center text-sm">
          <p>{t("fill.documentFailed")}</p>
          <Button type="button" variant="outline" className="h-11" onClick={() => setVersion((v) => v + 1)}>
            {t("common.tryAgain")}
          </Button>
        </div>
      ) : pdf.status === "loading" || width === 0 ? (
        <div role="status" aria-busy className="flex h-64 items-center justify-center gap-2 rounded-xl border bg-card text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          {t("fill.openingDocument")}
        </div>
      ) : (
        <div className="overflow-x-auto overscroll-x-contain">
          <PdfPages
            doc={pdf.doc}
            pages={pdf.pages}
            width={pageWidth}
            className="items-start"
            overlay={overlay}
            pageLabel={(index, total) => t("fill.pageLabel", { page: index + 1, total })}
          />
        </div>
      )}
    </div>
  );
}
