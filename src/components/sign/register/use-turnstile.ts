"use client";

// ============================================================
// Doc Sign, registration page: the optional Cloudflare Turnstile widget. With no site key it does nothing at
// all (no script, no request to Cloudflare). With one, it loads Cloudflare's script once, draws the widget in
// the element it hands back, and keeps the token the widget gives (null until then, and again after it expires
// or after `reset`). The route page's own headers allow exactly this script and frame (next.config.ts).
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import { TURNSTILE_SCRIPT_URL } from "@/lib/sign/registration/types";

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = "halo-turnstile-script";
/** Turnstile's own language codes. */
const WIDGET_LANGUAGE: Record<SignerLocale, string> = { en: "en", ms: "ms", zh: "zh-cn", ko: "ko" };

function whenReady(onReady: () => void): () => void {
  if (window.turnstile) {
    onReady();
    return () => {};
  }
  let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
  if (!script) {
    script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = `${TURNSTILE_SCRIPT_URL}?render=explicit`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }
  script.addEventListener("load", onReady);
  return () => script?.removeEventListener("load", onReady);
}

export function useTurnstile(siteKey: string | null, locale: SignerLocale) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey) return;
    let live = true;
    const stop = whenReady(() => {
      if (!live || !container.current || !window.turnstile || widget.current) return;
      widget.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        theme: "auto",
        language: WIDGET_LANGUAGE[locale],
        callback: (t: string) => {
          setFailed(false);
          setToken(t);
        },
        "expired-callback": () => setToken(null),
        "error-callback": () => {
          setToken(null);
          setFailed(true);
        },
      });
    });
    return () => {
      live = false;
      stop();
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
    // the widget is drawn once per page: a language change does not redraw it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  /** A new check is needed (the token was used, or was refused). */
  const reset = useCallback(() => {
    setToken(null);
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, []);

  return { container, token, failed, reset, enabled: siteKey !== null };
}
