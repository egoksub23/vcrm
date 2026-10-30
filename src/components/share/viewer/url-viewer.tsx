"use client";

// Full-screen iframe viewer for URL-type Secure Share links.
// Keeps halo.vircle.tech/v/<token> in the address bar.
// Burns the token on first mount (one-time view).
// Falls back gracefully when the target refuses embedding.

import { useEffect, useRef, useState } from "react";
import { AlertCircle, ExternalLink, Globe, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

interface UrlViewerProps {
  token: string;
  title: string;
  redirectUrl: string;
  product: string;
}

type LoadState = "loading" | "loaded" | "blocked";

export function UrlViewer({ token, title, redirectUrl, product }: UrlViewerProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const burnedRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Burn the token exactly once — one-time view.
  useEffect(() => {
    if (burnedRef.current) return;
    burnedRef.current = true;
    void fetch(`/api/share/public/${token}/burn`, {
      method: "POST",
      keepalive: true,
    }).catch(() => {});
  }, [token]);

  function handleIframeLoad() {
    // Try to detect X-Frame-Options blocking. Cross-origin iframes always
    // throw a SecurityError on contentDocument access — that's expected and
    // means the page loaded normally. An empty same-origin document means
    // the browser showed its own "refused to connect" error page.
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc && doc.body?.innerHTML === "") {
        setLoadState("blocked");
        return;
      }
    } catch {
      // SecurityError = cross-origin iframe loaded — content is showing.
    }
    setLoadState("loaded");
  }

  // After 20 s still loading → assume blocked or very slow network.
  useEffect(() => {
    if (loadState !== "loading") return;
    const id = setTimeout(() => setLoadState("blocked"), 20_000);
    return () => clearTimeout(id);
  }, [loadState]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      {/* Thin branded header */}
      <div className="flex items-center gap-2 px-4 h-10 border-b border-border bg-card shrink-0">
        <Globe className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium text-foreground truncate flex-1 min-w-0">{title}</span>
        <span className="text-[11px] text-muted-foreground/60 whitespace-nowrap shrink-0">
          Shared via {product}
        </span>
      </div>

      {/* Viewer area */}
      <div className="flex-1 relative overflow-hidden">
        {loadState === "blocked" ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <AlertCircle className="size-6 text-muted-foreground" />
            </div>
            <div className="max-w-xs">
              <p className="font-semibold text-foreground">This page can&apos;t be shown here</p>
              <p className="mt-1 text-sm text-muted-foreground">
                The content prevents embedding. Open it directly to view it.
              </p>
            </div>
            <Button variant="outline" onClick={() => window.open(redirectUrl, "_blank")}>
              <ExternalLink className="size-4" />
              Open in new tab
            </Button>
          </div>
        ) : (
          <>
            {loadState === "loading" && (
              <div className="absolute inset-0 flex items-center justify-center bg-background z-10 pointer-events-none">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={redirectUrl}
              title={title}
              className="w-full h-full border-0"
              onLoad={handleIframeLoad}
            />
          </>
        )}
      </div>
    </div>
  );
}
