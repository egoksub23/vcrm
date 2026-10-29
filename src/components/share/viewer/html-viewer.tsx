"use client";

// Renders an HTML share (DOCX→HTML or uploaded .html) in a sandboxed iframe.
// Heartbeat pings match the PDF viewer cadence (every 5 s).

import { useEffect, useRef } from "react";
import { Download } from "lucide-react";

import type { ShareLoadInfo } from "@/app/v/[token]/load";

interface HtmlViewerProps {
  token: string;
  share: ShareLoadInfo;
  product: string;
}

export function HtmlViewer({ token, share, product }: HtmlViewerProps) {
  const startRef = useRef(Date.now());

  // Heartbeat — update duration every 5 s
  useEffect(() => {
    const id = setInterval(() => {
      const durationMs = Date.now() - startRef.current;
      void fetch(`/api/share/public/${token}/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationMs, pageDwells: {} }),
        keepalive: true,
      }).catch(() => {});
    }, 5000);

    const onUnload = () => {
      const durationMs = Date.now() - startRef.current;
      navigator.sendBeacon(
        `/api/share/public/${token}/ping`,
        JSON.stringify({ durationMs, pageDwells: {} }),
      );
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      clearInterval(id);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [token]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header bar */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-card px-4">
        <span className="text-sm font-medium text-foreground truncate max-w-xs">{share.title}</span>
        <div className="flex items-center gap-2">
          {share.downloadEnabled && (
            <a
              href={`/api/share/public/${token}/file?download=1`}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Download className="size-3.5" />
              Download
            </a>
          )}
          <span className="text-xs text-muted-foreground/60">{product}</span>
        </div>
      </div>

      {/* Sandboxed iframe */}
      <iframe
        src={`/api/share/public/${token}/file`}
        sandbox="allow-scripts allow-same-origin"
        className="flex-1 w-full border-0"
        title={share.title}
        style={{ minHeight: "calc(100vh - 2.75rem)" }}
      />
    </div>
  );
}
