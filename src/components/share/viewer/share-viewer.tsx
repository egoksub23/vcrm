"use client";

// ============================================================
// Secure Share public viewer. Shows the document title and renders
// the PDF using the same pdfjs viewer as Doc Sign. Sends page-time
// heartbeat pings every 5 seconds. Download button if enabled.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, Loader2, AlertCircle } from "lucide-react";

import { PdfPages, usePdf } from "@/components/sign/pdf-pages";
import type { ShareLoadInfo } from "@/app/v/[token]/load";

interface ShareViewerProps {
  token: string;
  initialShare: ShareLoadInfo;
  product: string;
}

const PDF_WIDTH = 720;
const PING_INTERVAL_MS = 5000;

export function ShareViewer({ token, initialShare, product }: ShareViewerProps) {
  const fileUrl = `/api/share/public/${token}/file`;
  const pdfState = usePdf(fileUrl);

  const startTimeRef = useRef<number>(Date.now());
  const pageDwellsRef = useRef<number[]>([]);
  const currentPageRef = useRef<number>(0);
  const lastPageEntryRef = useRef<number>(Date.now());

  // Track the current page via IntersectionObserver on scroll
  const containerRef = useRef<HTMLDivElement>(null);

  const ping = useCallback(async (durationMs: number, pageDwells: number[]) => {
    try {
      await fetch(`/api/share/public/${token}/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationMs, pageDwells }),
      });
    } catch {
      // best effort
    }
  }, [token]);

  // Heartbeat: send ping every 5 seconds
  useEffect(() => {
    if (pdfState.status !== "ready") return;

    const interval = setInterval(() => {
      const now = Date.now();
      // Record dwell time on current page
      const dwell = now - lastPageEntryRef.current;
      const dwells = [...(pageDwellsRef.current ?? [])];
      const pageIdx = currentPageRef.current;
      dwells[pageIdx] = (dwells[pageIdx] ?? 0) + dwell;
      pageDwellsRef.current = dwells;
      lastPageEntryRef.current = now;

      const totalMs = now - startTimeRef.current;
      void ping(totalMs, dwells);
    }, PING_INTERVAL_MS);

    // Final ping on unload
    const handleUnload = () => {
      const now = Date.now();
      const dwell = now - lastPageEntryRef.current;
      const dwells = [...(pageDwellsRef.current ?? [])];
      const pageIdx = currentPageRef.current;
      dwells[pageIdx] = (dwells[pageIdx] ?? 0) + dwell;
      const totalMs = now - startTimeRef.current;
      void ping(totalMs, dwells);
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      clearInterval(interval);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [pdfState.status, ping]);

  // Track current page via scroll position
  useEffect(() => {
    const container = containerRef.current;
    if (!container || pdfState.status !== "ready") return;

    const pageEls = container.querySelectorAll<HTMLElement>("[data-page]");
    if (pageEls.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Number((entry.target as HTMLElement).dataset.page ?? 0);
            if (idx !== currentPageRef.current) {
              const now = Date.now();
              const dwell = now - lastPageEntryRef.current;
              const dwells = [...(pageDwellsRef.current ?? [])];
              dwells[currentPageRef.current] = (dwells[currentPageRef.current] ?? 0) + dwell;
              pageDwellsRef.current = dwells;
              lastPageEntryRef.current = now;
              currentPageRef.current = idx;
            }
          }
        }
      },
      { threshold: 0.5 },
    );

    pageEls.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pdfState.status]);

  const pageCount = pdfState.status === "ready" ? pdfState.pages.length : null;

  return (
    <div className="min-h-screen bg-muted/30 flex flex-col">
      {/* Header bar */}
      <header className="sticky top-0 z-10 bg-background border-b border-border px-4 py-3 flex items-center gap-3">
        <FileText className="size-5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{initialShare.title}</p>
          {pageCount !== null && (
            <p className="text-xs text-muted-foreground">{pageCount} {pageCount === 1 ? "page" : "pages"}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {initialShare.downloadEnabled && (
            <a
              href={`${fileUrl}?download=1`}
              download={initialShare.fileName}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Download className="size-3.5" />
              Download
            </a>
          )}
        </div>
      </header>

      {/* PDF viewer */}
      <main className="flex-1 flex flex-col items-center py-6 px-4" ref={containerRef}>
        {pdfState.status === "loading" && (
          <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm">Loading document…</p>
          </div>
        )}

        {pdfState.status === "error" && (
          <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
            <AlertCircle className="size-8 text-red-400" />
            <p className="text-sm text-center max-w-sm">
              {pdfState.code === "fetch_failed"
                ? "Could not load the document. The link may have expired."
                : "This document could not be opened."}
            </p>
          </div>
        )}

        {pdfState.status === "ready" && (
          <PdfPages
            doc={pdfState.doc}
            pages={pdfState.pages}
            width={Math.min(PDF_WIDTH, typeof window !== "undefined" ? window.innerWidth - 32 : PDF_WIDTH)}
            release
            gap={16}
            pageLabel={(i, total) => `Page ${i + 1} of ${total}`}
          />
        )}
      </main>

      <footer className="py-3 text-center text-xs text-muted-foreground border-t border-border">
        Shared via {product}
      </footer>
    </div>
  );
}
