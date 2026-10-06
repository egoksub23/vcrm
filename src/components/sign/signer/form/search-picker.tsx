"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: picking from a long list (countries, banks, the MSIC business activity codes).
// A text box that searches as you type, and the matches below it: by code or by any word, in the page's language or
// in English. One choice (`single`), or several added one by one (`multi`, shown as a list with a remove button each).
//
// The combobox pattern of the WAI-ARIA authoring practices: the box is `role="combobox"` and owns a `listbox`;
// the arrow keys move through the matches without leaving the box, Enter picks, Escape closes; a screen reader hears
// how many matches there are. The matches are in the page (not a floating menu), so a phone's keyboard never hides them,
// and every row is at least 44 px tall.
// ============================================================

import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FieldOption } from "@/lib/sign/forms/types";
import { pickerKey } from "@/lib/sign/client/picker-keys";
import { searchItems } from "@/lib/sign/lists/logic";
import { cn } from "@/lib/utils";

import { useFormLocale, useFormText } from "./form-ui";

/** How many matches are shown at once; the rest are reached by typing more. */
export const PICKER_LIMIT = 50;

export interface SearchPickerProps {
  /** The id of the text box (the field's label points at it). */
  id: string;
  options: readonly FieldOption[];
  mode: "single" | "multi";
  /** The values chosen: none or one (single), any number (multi). */
  selected: readonly string[];
  onChange: (values: string[]) => void;
  /** The person left the picker altogether. */
  onBlur?: () => void;
  invalid?: boolean;
  describedBy?: string;
  /** What the field is called, for a screen reader ("Search State"). */
  label: string;
  /** Show the stored value before the name (a code the person may know by heart). */
  showCode?: boolean;
  /** Multi: the most that may be chosen. */
  max?: number;
  /** Start with the list open and this text typed (for tests and previews; a person opens it by touching the box). */
  initial?: { open: boolean; query?: string };
}

const BOX =
  "h-11 w-full min-w-0 text-base aria-[invalid=true]:border-destructive";
const ROW = "flex min-h-11 w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left text-base leading-snug";

export function SearchPicker({ id, options, mode, selected, onChange, onBlur, invalid, describedBy, label, showCode, max, initial }: SearchPickerProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const locale = useFormLocale();
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initial?.query ?? "");
  const [open, setOpen] = useState(initial?.open ?? false);
  const [active, setActive] = useState(0);

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const nameOf = (o: FieldOption) => text(o.label) || o.value;
  const shown = (o: FieldOption) => (showCode ? `${o.value}  ${nameOf(o)}` : nameOf(o));
  const picked = new Set(selected);
  const pickedKey = selected.join("|");

  // the matches: in multi mode what is already added is not offered again (the key keeps the list from being searched again on every render)
  const pool = useMemo(() => {
    const taken = new Set(pickedKey === "" ? [] : pickedKey.split("|"));
    return mode === "multi" ? options.filter((o) => !taken.has(o.value)) : options;
  }, [options, mode, pickedKey]);
  const matches = useMemo(() => searchItems(pool, query, locale, PICKER_LIMIT), [pool, query, locale]);
  const truncated = matches.length >= PICKER_LIMIT;
  const atMax = mode === "multi" && max !== undefined && selected.length >= max;

  const chosenOption = mode === "single" ? byValue.get(selected[0] ?? "") : undefined;
  const inputValue = open ? query : mode === "single" && chosenOption ? nameOf(chosenOption) : query;

  // keep the highlighted match in view
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, listId]);

  function choose(o: FieldOption) {
    if (mode === "single") {
      onChange([o.value]);
      setOpen(false);
      setQuery("");
      return;
    }
    if (atMax) return;
    onChange([...selected, o.value]);
    setQuery("");
    setActive(0);
    // the matches close (what was added shows below the box); the focus stays, and typing opens them again for the next one
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const r = pickerKey(e.key, { open, active }, matches.length);
    if (r.handled) e.preventDefault();
    if (r.pick && matches[r.state.active]) {
      choose(matches[r.state.active]);
      return;
    }
    setOpen(r.state.open);
    setActive(r.state.active);
    if (r.cancel) setQuery("");
  }

  function leave(e: React.FocusEvent) {
    // focus moving inside the picker (a match, a remove button) is not leaving it
    if (root.current?.contains(e.relatedTarget as Node | null)) return;
    setOpen(false);
    setQuery("");
    onBlur?.();
  }

  const activeId = open && matches[active] ? `${listId}-${active}` : undefined;

  return (
    <div ref={root} className="space-y-2" onBlur={leave}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-label={t("search.label", { label })}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          // at the limit the box can no longer take anything, but it keeps the focus (a disabled box would drop it)
          readOnly={atMax}
          aria-readonly={atMax || undefined}
          value={inputValue}
          placeholder={atMax ? t("search.limit", { max: max ?? 0 }) : t("search.placeholder")}
          className={BOX}
          onFocus={() => {
            setOpen(!atMax);
            setQuery("");
            setActive(0);
          }}
          onClick={() => setOpen(!atMax)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {mode === "single" && chosenOption ? (
          <Button type="button" variant="outline" className="size-11 shrink-0 p-0" aria-label={t("search.clear", { label })} onClick={() => onChange([])}>
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>

      <span role="status" className="sr-only">
        {open ? (matches.length === 0 ? t("search.noMatches") : t("search.results", { count: matches.length })) : ""}
      </span>

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t("search.label", { label })}
          // a tap on a match must not blur the box first
          onMouseDown={(e) => e.preventDefault()}
          className="max-h-72 overflow-y-auto overscroll-contain rounded-lg border bg-background shadow-sm"
        >
          {matches.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">{query.trim() ? t("search.noMatchesFor", { query: query.trim() }) : t("search.noMatches")}</p>
          ) : (
            matches.map((o, i) => (
              <div
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={picked.has(o.value)}
                data-active={i === active || undefined}
                className={cn(ROW, "border-b last:border-b-0", i === active && "bg-accent text-accent-foreground", picked.has(o.value) && "font-medium")}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(o)}
              >
                {showCode ? <span className="shrink-0 font-mono text-sm tabular-nums leading-snug">{o.value}</span> : null}
                <span className="min-w-0 flex-1 break-words">{nameOf(o)}</span>
              </div>
            ))
          )}
          {truncated ? <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t("search.more", { shown: PICKER_LIMIT })}</p> : null}
        </div>
      ) : null}

      {mode === "multi" ? (
        <div className="space-y-2">
          {selected.length > 0 ? (
            <ul aria-label={t("search.selected", { count: selected.length })} className="space-y-2">
              {selected.map((v, i) => {
                const o = byValue.get(v);
                return (
                  <li key={v} className="flex min-h-11 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-base">
                    <span className="min-w-0 flex-1 break-words">{o ? shown(o) : v}</span>
                    <Button type="button" variant="ghost" className="size-9 shrink-0 p-0" aria-label={t("search.remove", { item: o ? shown(o) : v, number: i + 1 })} onClick={() => onChange(selected.filter((x) => x !== v))}>
                      <X className="size-4" aria-hidden />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {max !== undefined ? <p className="text-xs text-muted-foreground">{t("search.count", { count: selected.length, max })}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
