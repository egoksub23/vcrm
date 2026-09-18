"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";

interface EmailHtmlViewProps {
  html: string;
}

const MIN_HEIGHT_PX = 60;
const MAX_HEIGHT_PX = 600;

/**
 * Renders an inbound email's original HTML body inside a sandboxed
 * iframe — the real security boundary here, not the sanitize call
 * below. `sandbox` deliberately omits both `allow-scripts` and
 * `allow-same-origin` (that specific pairing is what lets sandboxed
 * content escape its box); without `allow-scripts` at all, nothing in
 * the iframe can execute script no matter what markup slips through,
 * and it can't reach the parent page, its cookies, or its DOM.
 * `allow-popups(-to-escape-sandbox)` is the one thing granted, so a
 * link inside the email (e.g. "View Order") opens a real new tab
 * instead of silently doing nothing.
 *
 * DOMPurify is defense-in-depth on top of that, not the primary
 * guard — mainly to drop `<script>`/`<meta>`/`<link>`/`<base>` outright
 * rather than relying solely on the sandbox to neutralize them.
 */
export function EmailHtmlView({ html }: EmailHtmlViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT_PX);

  const sanitized = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        WHOLE_DOCUMENT: true,
        FORBID_TAGS: ["script", "meta", "link", "base"],
      }),
    [html],
  );

  // Auto-size to the email's actual content height (capped), so short
  // notifications don't leave a tall empty iframe and long ones scroll
  // internally instead of taking over the whole thread.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => {
      try {
        const doc = iframe.contentDocument;
        const measured = doc?.documentElement?.scrollHeight ?? MIN_HEIGHT_PX;
        setHeight(Math.min(Math.max(measured + 16, MIN_HEIGHT_PX), MAX_HEIGHT_PX));
      } catch {
        // Inaccessible for some reason — keep the current height rather
        // than fail the render.
      }
    };
    iframe.addEventListener("load", onLoad);
    return () => iframe.removeEventListener("load", onLoad);
  }, [sanitized]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={sanitized}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      title="Email content"
      className="w-full rounded-lg border border-border/60 bg-white"
      style={{ height }}
    />
  );
}
