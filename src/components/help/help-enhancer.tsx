"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

import { isHelpLink } from "@/lib/help/nav";

interface Zoomed {
  src: string;
  alt: string;
}

/**
 * Wraps the server-rendered article HTML and adds the behaviour plain HTML
 * cannot have: click-to-zoom screenshots, copy buttons on code blocks,
 * client-side navigation for /help links, and scroll-to-top on a new page.
 * It uses event delegation, so the article itself stays a server component.
 */
export function HelpEnhancer({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Help");
  const router = useRouter();
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [zoomed, setZoomed] = useState<Zoomed | null>(null);

  // A new page starts at the top (the scroll container is the dashboard's <main>,
  // which the router does not reset); a #fragment scrolls to its heading.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const target = hash ? document.getElementById(decodeURIComponent(hash)) : null;
    if (target) {
      target.scrollIntoView();
      return;
    }
    let node = ref.current?.parentElement ?? null;
    while (node) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        node.scrollTo({ top: 0 });
        return;
      }
      node = node.parentElement;
    }
    window.scrollTo({ top: 0 });
  }, [pathname]);

  useEffect(() => {
    if (!zoomed) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    const zoom = target.closest<HTMLElement>("[data-help-zoom]");
    if (zoom) {
      const img = zoom.querySelector("img");
      if (img) setZoomed({ src: img.currentSrc || img.src, alt: img.alt });
      return;
    }

    const copy = target.closest<HTMLButtonElement>("[data-help-copy]");
    if (copy) {
      const code = copy.parentElement?.querySelector("code")?.textContent ?? "";
      const original = copy.textContent;
      navigator.clipboard
        ?.writeText(code)
        .then(() => {
          copy.textContent = copy.dataset.labelCopied ?? t("copied");
          copy.setAttribute("data-copied", "");
          window.setTimeout(() => {
            copy.textContent = original;
            copy.removeAttribute("data-copied");
          }, 1500);
        })
        .catch(() => {});
      return;
    }

    // Follow /help links without a full page load.
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (link && !e.defaultPrevented && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      const href = link.getAttribute("href") ?? "";
      if (isHelpLink(href) && !link.target) {
        e.preventDefault();
        router.push(href);
      }
    }
  };

  return (
    <div ref={ref} onClick={onClick}>
      {children}
      {zoomed ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={zoomed.alt}
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-[60] flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-background/90 p-4 backdrop-blur-sm"
        >
          <button
            ref={closeRef}
            type="button"
            onClick={() => setZoomed(null)}
            aria-label={t("closeImage")}
            className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-foreground hover:bg-muted"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoomed.src}
            alt={zoomed.alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-full cursor-default rounded-lg border border-border object-contain shadow-2xl"
          />
          {zoomed.alt ? (
            <p className="max-w-2xl text-center text-sm text-muted-foreground">{zoomed.alt}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
