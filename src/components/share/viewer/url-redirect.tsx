"use client";

// Click-through page for URL-redirect share links.
// Shows the destination hostname, records a ping, then redirects after 3 s.

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

interface UrlRedirectProps {
  token: string;
  title: string;
  redirectUrl: string;
  product: string;
}

export function UrlRedirect({ token, title, redirectUrl, product }: UrlRedirectProps) {
  const [countdown, setCountdown] = useState(3);
  const pingedRef = useRef(false);

  const hostname = (() => {
    try { return new URL(redirectUrl).hostname; } catch { return redirectUrl; }
  })();

  function go() {
    if (!pingedRef.current) {
      pingedRef.current = true;
      void fetch(`/api/share/public/${token}/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationMs: 0, pageDwells: {} }),
        keepalive: true,
      }).catch(() => {});
    }
    window.location.href = redirectUrl;
  }

  useEffect(() => {
    if (countdown <= 0) { go(); return; }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center space-y-4">
        <div className="flex justify-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
            <ExternalLink className="size-6 text-primary" />
          </div>
        </div>
        <div>
          <p className="font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            You are being redirected to
          </p>
          <p className="mt-0.5 text-sm font-medium text-foreground break-all">{hostname}</p>
        </div>
        <Button onClick={go} className="w-full">
          {countdown > 0 ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Redirecting in {countdown}…
            </>
          ) : (
            <>
              <ExternalLink className="size-4" />
              Continue
            </>
          )}
        </Button>
        <p className="text-[11px] text-muted-foreground/60">Shared via {product}</p>
      </div>
    </div>
  );
}
