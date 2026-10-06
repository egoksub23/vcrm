"use client";

// ============================================================
// Doc Sign: show the pages of a PDF in the browser (pdfjs-dist, Apache-2.0), one block per page, each
// with a layer on top for whatever the screen draws over the page: the editor's fields, the signing
// page's boxes to fill in.
//
// Everything that sits on a page is positioned in fractions of the page (0 to 1, origin top-left) as
// percentages, so it stays where it was put at any width and matches how the PDF engine reads the same
// numbers (src/lib/sign/pdf/geometry.ts). Pages are drawn only when they come near the screen, and drawn
// again when the width changes.
// ============================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

import { cn } from "@/lib/utils";

export interface PdfPageSize {
  /** Visible size in points, after any rotation of the page. */
  width: number;
  height: number;
}

export type PdfState =
  | { status: "loading" }
  | { status: "error"; code: "fetch_failed" | "unreadable"; httpStatus?: number }
  | { status: "ready"; doc: PDFDocumentProxy; pages: PdfPageSize[] };

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

/** Load pdfjs once, with its worker, on the first use. */
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      return mod;
    });
    // a failed load must be tried again next time
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

/** Fetch a PDF from an address on this site and open it. `version` changes to load it again. */
export function usePdf(url: string | null, version: number | string = 0): PdfState {
  // The result is stored with the request it answers, so a new address reads as "loading" until it arrives.
  const key = `${url}|${version}`;
  const [result, setResult] = useState<({ key: string } & Exclude<PdfState, { status: "loading" }>) | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    (async () => {
      let bytes: ArrayBuffer;
      try {
        const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setResult({ key, status: "error", code: "fetch_failed", httpStatus: res.status });
          return;
        }
        bytes = await res.arrayBuffer();
      } catch {
        if (!cancelled) setResult({ key, status: "error", code: "fetch_failed" });
        return;
      }
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) return;
        task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        const doc = await task.promise;
        const pages: PdfPageSize[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const v = page.getViewport({ scale: 1 });
          pages.push({ width: v.width, height: v.height });
          page.cleanup();
        }
        if (!cancelled) setResult({ key, status: "ready", doc, pages });
      } catch {
        if (!cancelled) setResult({ key, status: "error", code: "unreadable" });
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url, key]);

  if (!url || !result || result.key !== key) return { status: "loading" };
  return result;
}

interface PdfPageViewProps {
  doc: PDFDocumentProxy;
  index: number;
  size: PdfPageSize;
  /** Width of the page on screen, in CSS pixels. */
  width: number;
  children?: ReactNode;
  className?: string;
  /** The page's label for screen readers, for example "Page 2 of 5". */
  label?: string;
}

function PdfPageView({ doc, index, size, width, children, className, label }: PdfPageViewProps) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Without IntersectionObserver every page is drawn at once.
  const [near, setNear] = useState(() => index === 0 || typeof IntersectionObserver === "undefined");
  const height = (width * size.height) / size.width;

  useEffect(() => {
    const el = holder.current;
    if (!el || near) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    const target = canvas.current;
    if (!target) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    (async () => {
      try {
        page = await doc.getPage(index + 1);
        if (cancelled) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / size.width) * ratio });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        const context = target.getContext("2d");
        if (!context) return;
        task = page.render({ canvas: target, canvasContext: context, viewport });
        await task.promise;
      } catch {
        // a render that was cancelled by a width change or by leaving the page is not an error
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      page?.cleanup();
    };
  }, [doc, index, near, size.width, width]);

  return (
    <div
      ref={holder}
      role="img"
      aria-label={label}
      data-page={index}
      className={cn("relative mx-auto overflow-hidden bg-white shadow-sm ring-1 ring-black/10", className)}
      style={{ width, height }}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden />
      {children}
    </div>
  );
}

export interface PdfPagesProps {
  doc: PDFDocumentProxy;
  pages: PdfPageSize[];
  /** Width of every page on screen, in CSS pixels. */
  width: number;
  /** What to draw over page `index`. It is placed to fill the page; position inside it with percentages. */
  overlay?: (index: number, onScreen: { width: number; height: number }) => ReactNode;
  pageLabel?: (index: number, total: number) => string;
  className?: string;
  gap?: number;
}

/** Every page of the document, one under another. */
export function PdfPages({ doc, pages, width, overlay, pageLabel, className, gap = 16 }: PdfPagesProps) {
  const items = useMemo(() => pages.map((size, index) => ({ size, index })), [pages]);
  return (
    <div className={cn("flex flex-col items-center", className)} style={{ gap }}>
      {items.map(({ size, index }) => (
        <PdfPageView key={index} doc={doc} index={index} size={size} width={width} label={pageLabel?.(index, pages.length)}>
          {overlay?.(index, { width, height: (width * size.height) / size.width })}
        </PdfPageView>
      ))}
    </div>
  );
}

/** The width available to an element, followed as it changes (for fitting pages to the screen). */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
