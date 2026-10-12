"use client";

// ============================================================
// KYC review, the ID image viewer.
//
// The image is fetched from OUR server (GET /api/kyc/validations/[id]/image), which fetches it from the back end and never hands over the back end's
// URL. The bytes become a blob URL for as long as the image is on screen; the URL is revoked when the viewer closes, the validation changes, the image
// is covered, or the page is left. Nothing is written to storage.
//
// What the screen does to DETER (it cannot prevent) copying a child's ID:
//   * a diagonal, repeating watermark over the image: the viewer's name, the time and "Halo" (a CSS background on an overlay)
//   * no download button; right-click and dragging the image are switched off
//   * the image is hidden behind a "Click to show" cover after 3 minutes without any interaction with the viewer, and as soon as the tab is hidden;
//     showing it again fetches it again (and is recorded again)
// A screenshot or a photo of the screen is not stopped by any of this. What it does is make a leaked image traceable to a person and a time, and the
// access log records who opened which validation.
// ============================================================

import { EyeOff, Maximize2, Minimize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { getImage } from "./api";
import { INITIAL_VIEW, canZoomIn, canZoomOut, rotate90, shouldCover, toggleFit, viewerKey, watermarkBackground, watermarkText, zoomIn, zoomLabel, zoomOut, resetView, type ViewerState } from "./helpers";
import { ErrorPanel } from "./parts";

interface Props {
  validationId: string;
  friendId: string | null;
  /** Who is looking: the name that goes in the watermark. */
  viewerName: string;
  locale: string;
  isAdmin: boolean;
}

const NO_CALLOUT = { WebkitTouchCallout: "none", WebkitUserSelect: "none" } as CSSProperties;

export type Phase = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "error"; code: string } | { kind: "covered" };

export function ImageViewer({ validationId, friendId, viewerName, locale, isAdmin }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [view, setView] = useState<ViewerState>(INITIAL_VIEW);
  const [stamp, setStamp] = useState(() => new Date());
  // set when the image arrives and on every interaction; read only by the idle check
  const lastActivity = useRef(0);
  const urlRef = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const release = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // Fetch when the viewer opens, and again when Retry or "Click to show" bumps `attempt`. The screen mounts one viewer per validation (a `key`), so a
  // new validation always starts here in the loading phase; the two handlers below put it back there for a retry.
  useEffect(() => {
    let cancelled = false;
    release();
    void getImage(validationId, friendId).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setPhase({ kind: "error", code: res.code });
        return;
      }
      const url = URL.createObjectURL(res.data);
      urlRef.current = url;
      lastActivity.current = Date.now();
      setStamp(new Date());
      setPhase({ kind: "ready", url });
    });
    return () => {
      cancelled = true;
      release();
    };
  }, [validationId, friendId, attempt, release]);

  const cover = useCallback(() => {
    release();
    setPhase((p) => (p.kind === "ready" ? { kind: "covered" } : p));
  }, [release]);

  // Idle for three minutes, or the tab goes to the background: cover the image and let go of the bytes.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const check = () => {
      if (shouldCover({ lastActivity: lastActivity.current, now: Date.now(), hidden: document.hidden })) cover();
    };
    const timer = window.setInterval(check, 5_000);
    const onVisibility = () => {
      if (document.hidden) cover();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [phase.kind, cover]);

  const touch = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);

  const again = useCallback(() => {
    setPhase({ kind: "loading" });
    setView(INITIAL_VIEW);
    setAttempt((n) => n + 1);
  }, []);

  const watermark = useMemo(() => watermarkBackground(watermarkText(viewerName, stamp, locale)), [viewerName, stamp, locale]);

  return (
    <ImageViewerView
      phase={phase}
      view={view}
      onView={(next) => setView(next)}
      watermark={watermark}
      isAdmin={isAdmin}
      onRetry={again}
      onShow={again}
      onActivity={touch}
    />
  );
}

export interface ViewProps {
  phase: Phase;
  view: ViewerState;
  onView: (next: ViewerState) => void;
  /** CSS `background-image` value of the watermark (helpers.watermarkBackground). */
  watermark: string;
  isAdmin: boolean;
  onRetry: () => void;
  onShow: () => void;
  /** The reviewer touched the viewer (resets the idle clock). */
  onActivity: () => void;
}

/** What is drawn for each phase. No effects and no timers here, so it renders the same in a test. */
export function ImageViewerView({ phase, view, onView, watermark, isAdmin, onRetry, onShow, onActivity }: ViewProps) {
  const t = useTranslations("Kyc.image");
  const touch = onActivity;
  const setView = (f: (s: ViewerState) => ViewerState) => onView(f(view));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    touch();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const next = viewerKey(view, e.key);
    if (next) {
      e.preventDefault();
      onView(next);
    }
  };

  const blockCopy = (e: { preventDefault: () => void }) => e.preventDefault();

  return (
    <section aria-labelledby="kyc-image-title" className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 id="kyc-image-title" className="font-medium text-foreground">
          {t("title")}
        </h3>
        {phase.kind === "ready" ? (
          <div role="toolbar" aria-label={t("toolbar")} className="flex flex-wrap items-center gap-1">
            <Button variant="outline" size="icon-sm" onClick={() => setView((s) => zoomOut(s))} disabled={!canZoomOut(view)} aria-label={t("zoomOut")} title={t("zoomOut")}>
              <ZoomOut aria-hidden />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
              {t("zoomLevel", { level: zoomLabel(view) })}
            </span>
            <Button variant="outline" size="icon-sm" onClick={() => setView((s) => zoomIn(s))} disabled={!canZoomIn(view)} aria-label={t("zoomIn")} title={t("zoomIn")}>
              <ZoomIn aria-hidden />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => setView((s) => rotate90(s))} aria-label={t("rotate")} title={t("rotate")}>
              <RotateCw aria-hidden />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => setView((s) => toggleFit(s))} aria-pressed={!view.fit} aria-label={view.fit ? t("actualSize") : t("fit")} title={view.fit ? t("actualSize") : t("fit")}>
              {view.fit ? <Maximize2 aria-hidden /> : <Minimize2 aria-hidden />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onView(resetView())}>
              {t("reset")}
            </Button>
          </div>
        ) : null}
      </div>

      {phase.kind === "loading" ? (
        <div role="status" aria-live="polite" className="h-64 animate-pulse rounded-lg bg-muted" data-testid="kyc-image-skeleton">
          <span className="sr-only">{t("loading")}</span>
        </div>
      ) : null}

      {phase.kind === "error" ? <ErrorPanel code={phase.code} isAdmin={isAdmin} compact onRetry={onRetry} /> : null}

      {phase.kind === "covered" ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-4 text-center">
          <EyeOff className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">{t("covered")}</p>
          <p className="text-xs text-muted-foreground">{t("coveredWhy")}</p>
          <Button onClick={onShow}>{t("show")}</Button>
        </div>
      ) : null}

      {phase.kind === "ready" ? (
        // The watermark is a SIBLING of the scrolling frame, not inside it: it stays over the visible part however far the image is zoomed or scrolled.
        <div className="relative overflow-hidden rounded-lg bg-black/80">
          <div
            role="group"
            tabIndex={0}
            aria-label={t("viewerLabel")}
            onKeyDown={onKeyDown}
            onPointerDown={touch}
            onPointerMove={touch}
            onWheel={touch}
            onScroll={touch}
            onFocus={touch}
            onContextMenu={blockCopy}
            onDragStart={blockCopy}
            className="max-h-[70vh] overflow-auto outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
            style={NO_CALLOUT}
          >
            <div className={cn("flex min-h-64 items-center justify-center p-2", !view.fit && "w-max min-w-full")}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL of a private image: next/image cannot optimise it and must never cache it */}
              <img
                src={phase.url}
                alt={t("alt")}
                draggable={false}
                onContextMenu={blockCopy}
                onDragStart={blockCopy}
                className={cn("block select-none", view.fit ? "max-h-[65vh] max-w-full object-contain" : "max-w-none")}
                style={{ transform: `scale(${view.zoom}) rotate(${view.rotate}deg)`, transformOrigin: "center center", transition: "transform 120ms ease-out" }}
              />
            </div>
          </div>
          <div aria-hidden className="pointer-events-none absolute inset-0 select-none" style={{ backgroundImage: watermark, backgroundRepeat: "repeat" }} data-testid="kyc-watermark" />
        </div>
      ) : null}

      <p className="mt-2 text-xs text-muted-foreground">{t("watermarkNote")}</p>
    </section>
  );
}
