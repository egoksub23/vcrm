"use client";

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useTranslations } from "next-intl";
import {
  Clock,
  Flag,
  Hand,
  Hash,
  Lightbulb,
  PawPrint,
  Plane,
  Search,
  Smile,
  Trophy,
  Utensils,
  type LucideIcon,
} from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { emojiForTone, searchEmoji } from "@/lib/emoji/search";
import { RECENT_MAX, pushRecent, readRecent, readTone, writeTone } from "@/lib/emoji/storage";
import type { EmojiData, EmojiEntry, EmojiGroupKey, SkinTone } from "@/lib/emoji/types";
import { useEmojiData } from "@/lib/emoji/use-emoji-data";

const GROUP_ICONS: Record<EmojiGroupKey, LucideIcon> = {
  smileys: Smile,
  people: Hand,
  animals: PawPrint,
  food: Utensils,
  travel: Plane,
  activities: Trophy,
  objects: Lightbulb,
  symbols: Hash,
  flags: Flag,
};

/** Emoji per row, and the most shown for a search (a one-letter query matches nearly all). */
const COLUMNS = 8;
const MAX_SEARCH_RESULTS = 240;
/** Categories rendered at once when the panel opens; the rest follow, one per tick. */
const INITIAL_GROUPS = 2;

const TONES: SkinTone[] = [0, 1, 2, 3, 4, 5];
/** Swatch colours for the tone selector (the skin tones themselves, not theme tokens). */
const TONE_SWATCH: Record<SkinTone, string> = {
  0: "#facc15",
  1: "#fcd9b6",
  2: "#e5b98c",
  3: "#c68e5f",
  4: "#8d5a3b",
  5: "#5c3a26",
};

const EmojiCell = memo(function EmojiCell({
  entry,
  glyph,
  tabbable,
  onPick,
  onHover,
}: {
  entry: EmojiEntry | undefined;
  glyph: string;
  tabbable: boolean;
  onPick: (glyph: string, keepOpen: boolean) => void;
  onHover: (entry: EmojiEntry | null, glyph: string) => void;
}) {
  const label = entry?.name ?? glyph;
  return (
    <button
      type="button"
      data-emoji-btn
      aria-label={label}
      title={label}
      tabIndex={tabbable ? 0 : -1}
      onClick={(e) => onPick(glyph, e.shiftKey)}
      onMouseEnter={() => onHover(entry ?? null, glyph)}
      onFocus={() => onHover(entry ?? null, glyph)}
      className="flex h-8 w-8 scroll-mt-7 items-center justify-center rounded-md text-xl leading-none hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {glyph}
    </button>
  );
});

/** The name of the emoji under the pointer or focus, in the panel footer. */
function HoverInfo({ setterRef }: { setterRef: RefObject<((e: EmojiEntry | null, glyph: string) => void) | null> }) {
  const [hover, setHover] = useState<{ entry: EmojiEntry | null; glyph: string } | null>(null);
  useEffect(() => {
    setterRef.current = (entry, glyph) => setHover({ entry, glyph });
    return () => {
      setterRef.current = null;
    };
  }, [setterRef]);
  if (!hover) return <span className="truncate text-xs text-muted-foreground">&nbsp;</span>;
  const code = hover.entry?.shortcodes[0];
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="text-base leading-none" aria-hidden>
        {hover.glyph}
      </span>
      <span className="truncate">{hover.entry ? (code ? `${hover.entry.name} · :${code}:` : hover.entry.name) : hover.glyph}</span>
    </span>
  );
}

/**
 * The picker's contents: search, category tabs, "Frequently used" and the grid.
 * Rendered inside the popover by `EmojiPicker`; also usable on its own. `data`
 * can be passed in (tests); otherwise it is loaded lazily on mount.
 */
export function EmojiPanel({
  onPick,
  data: dataProp,
  searchRef,
  className,
}: {
  onPick: (emoji: string, keepOpen: boolean) => void;
  data?: EmojiData;
  searchRef?: RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const t = useTranslations("Emoji");
  const loaded = useEmojiData(!dataProp);
  const data = dataProp ?? loaded.data;

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [tone, setTone] = useState<SkinTone>(readTone);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [activeGroup, setActiveGroup] = useState<EmojiGroupKey | "recent">(recent.length > 0 ? "recent" : "smileys");
  const [rendered, setRendered] = useState(INITIAL_GROUPS);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hoverSetter = useRef<((e: EmojiEntry | null, glyph: string) => void) | null>(null);

  // Render the remaining categories one at a time so the panel appears at once.
  const groupCount = data?.groups.length ?? 0;
  useEffect(() => {
    if (rendered >= groupCount) return;
    const id = window.setTimeout(() => setRendered((n) => n + 1), 24);
    return () => window.clearTimeout(id);
  }, [rendered, groupCount]);

  const results = useMemo(
    () => (data && query.trim() && deferredQuery.trim() ? searchEmoji(data, deferredQuery, MAX_SEARCH_RESULTS) : null),
    [data, query, deferredQuery],
  );

  const handlePick = useCallback(
    (glyph: string, keepOpen: boolean) => {
      setRecent(pushRecent(glyph));
      onPick(glyph, keepOpen);
    },
    [onPick],
  );
  const handleHover = useCallback((entry: EmojiEntry | null, glyph: string) => {
    hoverSetter.current?.(entry, glyph);
  }, []);

  const scrollToGroup = (key: EmojiGroupKey | "recent") => {
    setActiveGroup(key);
    if (query) setQuery("");
    setRendered(groupCount);
    // Wait a frame so a category that was not rendered yet exists.
    requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      const section = scroller?.querySelector<HTMLElement>(`[data-group="${key}"]`);
      if (!scroller || !section) return;
      scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
  };

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller || results) return;
    const top = scroller.getBoundingClientRect().top + 12;
    let current: EmojiGroupKey | "recent" | null = null;
    for (const s of scroller.querySelectorAll<HTMLElement>("[data-group]")) {
      if (s.getBoundingClientRect().top <= top) current = s.dataset.group as EmojiGroupKey | "recent";
      else break;
    }
    if (current) setActiveGroup(current);
  };

  const focusFirst = () => scrollerRef.current?.querySelector<HTMLButtonElement>("[data-emoji-btn]")?.focus();

  /** Arrow keys move through the grid by what is on screen, so category edges just work. */
  const handleGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const scroller = scrollerRef.current;
    const buttons = scroller ? Array.from(scroller.querySelectorAll<HTMLButtonElement>("[data-emoji-btn]")) : [];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowLeft") next = buttons[at - 1];
    else if (e.key === "ArrowRight") next = buttons[at + 1];
    else if (e.key === "Home") next = buttons[0];
    else if (e.key === "End") next = buttons[buttons.length - 1];
    else {
      const cur = buttons[at].getBoundingClientRect();
      const cx = cur.left + cur.width / 2;
      const down = e.key === "ArrowDown";
      let rowTop: number | null = null;
      let bestDist = Infinity;
      const scan = down ? buttons.slice(at + 1) : buttons.slice(0, at).reverse();
      for (const b of scan) {
        const r = b.getBoundingClientRect();
        const differentRow = down ? r.top > cur.top + 2 : r.top < cur.top - 2;
        if (!differentRow) continue;
        if (rowTop === null) rowTop = r.top;
        if (Math.abs(r.top - rowTop) > 2) break;
        const dist = Math.abs(r.left + r.width / 2 - cx);
        if (dist < bestDist) {
          bestDist = dist;
          next = b;
        }
      }
      if (!next && !down) searchRef?.current?.focus();
    }
    next?.focus();
  };

  const chooseTone = (next: SkinTone) => {
    setTone(next);
    writeTone(next);
  };

  const sections: { key: EmojiGroupKey | "recent"; label: string; cells: { entry: EmojiEntry | undefined; glyph: string }[] }[] = [];
  if (data && !results) {
    if (recent.length > 0) {
      sections.push({
        key: "recent",
        label: t("frequentlyUsed"),
        cells: recent.slice(0, RECENT_MAX).map((glyph) => ({ entry: data.byEmoji.get(glyph), glyph })),
      });
    }
    data.groups.slice(0, rendered).forEach((g) =>
      sections.push({
        key: g.key,
        label: t(`groups.${g.key}`),
        cells: g.entries.map((entry) => ({ entry, glyph: emojiForTone(entry, tone) })),
      }),
    );
  }
  const firstKey = sections[0]?.cells[0]?.glyph ?? results?.[0]?.emoji;

  const tabs: { key: EmojiGroupKey | "recent"; label: string; Icon: LucideIcon }[] = [
    ...(recent.length > 0 ? [{ key: "recent" as const, label: t("frequentlyUsed"), Icon: Clock }] : []),
    ...(data?.groups ?? []).map((g) => ({ key: g.key, label: t(`groups.${g.key}`), Icon: GROUP_ICONS[g.key] })),
  ];

  return (
    <div className={cn("flex h-[22rem] max-h-[70vh] w-full flex-col", className)}>
      <div className="relative px-2 pt-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 mt-1 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusFirst();
            } else if (e.key === "Enter" && results && results.length > 0) {
              e.preventDefault();
              handlePick(emojiForTone(results[0], tone), e.shiftKey);
            }
          }}
          placeholder={t("search")}
          aria-label={t("search")}
          autoComplete="off"
          className="h-8 w-full rounded-lg border border-border bg-muted pl-8 pr-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
      </div>

      <div
        role="toolbar"
        aria-label={t("categories")}
        className="flex items-center gap-0.5 border-b border-border px-2 py-1"
      >
        {tabs.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={!results && activeGroup === key}
            onClick={() => scrollToGroup(key)}
            className={cn(
              "flex h-7 flex-1 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
              !results && activeGroup === key && "bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>

      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        onKeyDown={handleGridKeyDown}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-1"
      >
        {!data ? (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            {loaded.failed ? t("loadFailed") : t("loading")}
          </p>
        ) : results ? (
          results.length === 0 ? (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              {t("noResults")}
            </p>
          ) : (
            <div role="group" aria-label={t("search")} className="grid gap-0.5 py-1" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
              {results.map((entry) => {
                const glyph = emojiForTone(entry, tone);
                return (
                  <EmojiCell key={entry.emoji} entry={entry} glyph={glyph} tabbable={glyph === firstKey} onPick={handlePick} onHover={handleHover} />
                );
              })}
            </div>
          )
        ) : (
          sections.map((s) => (
            <section key={s.key} data-group={s.key} aria-label={s.label}>
              <h3 className="sticky top-0 z-10 bg-popover py-1 text-[11px] font-medium text-muted-foreground">{s.label}</h3>
              <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
                {s.cells.map((c, i) => (
                  <EmojiCell
                    key={`${c.glyph}-${i}`}
                    entry={c.entry}
                    glyph={c.glyph}
                    tabbable={s.key === sections[0].key && i === 0}
                    onPick={handlePick}
                    onHover={handleHover}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <HoverInfo setterRef={hoverSetter} />
        </div>
        <div role="radiogroup" aria-label={t("skinTone")} className="flex shrink-0 items-center gap-1">
          {TONES.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={tone === n}
              aria-label={t(`tones.${n}`)}
              title={t(`tones.${n}`)}
              onClick={() => chooseTone(n)}
              className={cn(
                "h-4 w-4 rounded-full border border-border/70 outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                tone === n && "ring-2 ring-primary ring-offset-1 ring-offset-popover",
              )}
              style={{ backgroundColor: TONE_SWATCH[n] }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The smiley button and its floating panel. Opens upward from the button
 * (portaled, so no composer clips it), closes on Escape or an outside click and
 * gives focus back to the field via `returnFocusTo`. `onPick` receives the glyph;
 * the caller inserts it (see `insertAtCursor` / `insertEmojiInEditor`).
 * Shift-click keeps the panel open to add several.
 */
export function EmojiPicker({
  onPick,
  disabled,
  returnFocusTo,
  className,
  iconClassName,
  side = "top",
  align = "start",
}: {
  onPick: (emoji: string) => void;
  disabled?: boolean;
  /** The field to focus when the panel closes (defaults to the button). */
  returnFocusTo?: () => HTMLElement | null | undefined;
  className?: string;
  iconClassName?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  const t = useTranslations("Emoji");
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const handlePick = useCallback(
    (glyph: string, keepOpen: boolean) => {
      onPick(glyph);
      if (!keepOpen) setOpen(false);
    },
    [onPick],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={t("add")}
        title={t("add")}
        className={cn(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <Smile className={cn("h-4 w-4", iconClassName)} />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        initialFocus={searchRef}
        finalFocus={() => returnFocusTo?.() ?? true}
        className="w-[22rem] max-w-[calc(100vw-2rem)] gap-0 p-0"
      >
        <EmojiPanel onPick={handlePick} searchRef={searchRef} />
      </PopoverContent>
    </Popover>
  );
}
