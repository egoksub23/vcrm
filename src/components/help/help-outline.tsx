"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { HelpHeading } from "@/lib/help/types";

/** The nearest ancestor that scrolls (the dashboard's <main>), or the window. */
function scrollParent(el: HTMLElement | null): HTMLElement | Window {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return window;
}

/** "On this page" outline with scroll-spy. Desktop only (the page shows a plain list on small screens). */
export function HelpOutline({ headings }: { headings: HelpHeading[] }) {
  const t = useTranslations("Help");
  const [activeId, setActiveId] = useState<string | null>(headings[0]?.id ?? null);

  useEffect(() => {
    if (headings.length === 0) return;
    const first = document.getElementById(headings[0].id);
    const parent = scrollParent(first);
    let frame = 0;

    const update = () => {
      frame = 0;
      const top = parent instanceof Window ? 0 : parent.getBoundingClientRect().top;
      // The last heading that has reached the upper part of the scroll area.
      let current = headings[0].id;
      for (const h of headings) {
        const el = document.getElementById(h.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - top <= 96) current = h.id;
        else break;
      }
      // At the very bottom the last heading may never reach the threshold.
      const atBottom =
        parent instanceof Window
          ? window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
          : parent.scrollTop + parent.clientHeight >= parent.scrollHeight - 4;
      if (atBottom && parent instanceof HTMLElement && parent.scrollTop > 0) current = headings[headings.length - 1].id;
      setActiveId(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    parent.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      parent.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [headings]);

  if (headings.length < 2) return null;

  return (
    <nav aria-label={t("onThisPage")} className="text-sm">
      <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t("onThisPage")}
      </p>
      <ul className="flex flex-col border-l border-border">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              aria-current={h.id === activeId ? "location" : undefined}
              className={cn(
                "-ml-px block border-l-2 py-1 pr-2 leading-snug transition-colors",
                h.depth === 3 ? "pl-6" : "pl-3",
                h.id === activeId
                  ? "border-primary font-medium text-primary"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
