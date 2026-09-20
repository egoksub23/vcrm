"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { emojiForTone, normaliseQuery } from "@/lib/emoji/search";
import type { EmojiEntry, SkinTone } from "@/lib/emoji/types";

/** The shortcode to show for a suggestion: the one that matches what was typed. */
function shortcodeLabel(entry: EmojiEntry, query: string): string {
  const q = normaliseQuery(query);
  return entry.shortcodes.find((c) => c.startsWith(q)) ?? entry.shortcodes.find((c) => c.includes(q)) ?? entry.shortcodes[0] ?? entry.name;
}

/**
 * The inline list under ":smi". Sits above the field it belongs to (the parent
 * is `relative`); mouse down picks without taking focus away from the field.
 */
export function EmojiSuggestions({
  items,
  query,
  selectedIndex,
  tone,
  onPick,
  onHover,
  className,
}: {
  items: EmojiEntry[];
  query: string;
  selectedIndex: number;
  tone: SkinTone;
  onPick: (entry: EmojiEntry) => void;
  onHover?: (index: number) => void;
  className?: string;
}) {
  const t = useTranslations("Emoji");
  if (items.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label={t("suggestions")}
      className={cn(
        "absolute bottom-full left-0 z-30 mb-1 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-md",
        className,
      )}
    >
      {items.map((entry, i) => (
        <button
          key={entry.emoji}
          type="button"
          role="option"
          aria-selected={i === selectedIndex}
          aria-label={entry.name}
          tabIndex={-1}
          onMouseDown={(e) => {
            // mousedown (not click) runs before the field's blur, so the caret
            // the insertion reads is still valid.
            e.preventDefault();
            onPick(entry);
          }}
          onMouseEnter={() => onHover?.(i)}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-popover-foreground",
            i === selectedIndex ? "bg-muted" : "hover:bg-muted",
          )}
        >
          <span className="text-lg leading-none" aria-hidden>
            {emojiForTone(entry, tone)}
          </span>
          <span className="truncate">:{shortcodeLabel(entry, query)}:</span>
        </button>
      ))}
    </div>
  );
}
