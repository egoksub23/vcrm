"use client";

import {
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";

import { getLoadedEmojiData, loadEmojiData } from "@/lib/emoji/data";
import { insertAtCursor, replaceRangeInField } from "@/lib/emoji/insert";
import { emojiForTone, searchEmoji } from "@/lib/emoji/search";
import { pushRecent, readTone } from "@/lib/emoji/storage";
import { expandClosedShortcode, parseEmojiTrigger } from "@/lib/emoji/trigger";
import type { EmojiData, EmojiEntry } from "@/lib/emoji/types";
import { EmojiSuggestions } from "./emoji-suggestions";

type Field = HTMLTextAreaElement | HTMLInputElement;

const MAX_SUGGESTIONS = 8;

/**
 * Wires the ":" shortcut and picker insertion into a controlled text field.
 *
 *   const emoji = useEmojiShortcut({ fieldRef, value, onValueChange: setValue });
 *   <textarea onChange={emoji.handleChange} onKeyDown={(e) => { if (emoji.handleKeyDown(e)) return; ... }}
 *             onSelect={emoji.handleSelect} onFocus={emoji.handleSelect} onBlur={emoji.handleBlur} />
 *   {emoji.suggestions}     // inside the field's `relative` wrapper
 *   <EmojiPicker onPick={emoji.insertEmoji} />
 *
 * The emoji data loads on the first ":" keystroke (never earlier).
 */
export function useEmojiShortcut({
  fieldRef,
  value,
  onValueChange,
  enabled = true,
  maxLength,
  onAfter,
}: {
  fieldRef: RefObject<Field | null>;
  value: string;
  onValueChange: (next: string) => void;
  /** Turn the shortcut off (read-only field, another popup owns the keys). */
  enabled?: boolean;
  maxLength?: number;
  /** Runs after an insertion has landed (e.g. re-measure an auto-growing textarea). */
  onAfter?: () => void;
}) {
  const [data, setData] = useState<EmojiData | null>(getLoadedEmojiData);
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [sel, setSel] = useState<{ key: string; index: number }>({ key: "", index: 0 });

  const ensureData = useCallback(() => {
    const loaded = getLoadedEmojiData();
    if (loaded) {
      setData(loaded);
      return;
    }
    loadEmojiData().then(setData, () => {});
  }, []);

  const trigger = useMemo(
    () => (enabled && caret !== null ? parseEmojiTrigger(value, caret) : null),
    [enabled, caret, value],
  );
  const queryKey = trigger ? `${trigger.start}:${trigger.query}` : "";
  const items = useMemo(
    () => (trigger && data ? searchEmoji(data, trigger.query, MAX_SUGGESTIONS) : []),
    [trigger, data],
  );
  const open = trigger !== null && dismissedKey !== queryKey && items.length > 0;
  const index = sel.key === queryKey ? Math.min(sel.index, Math.max(items.length - 1, 0)) : 0;

  const pick = useCallback(
    (entry: EmojiEntry) => {
      if (!trigger) return;
      const glyph = emojiForTone(entry, readTone());
      const end = trigger.start + 1 + trigger.query.length;
      const ok = replaceRangeInField(fieldRef.current, trigger.start, end, glyph, onValueChange, {
        maxLength,
        onAfter,
        fallbackValue: value,
      });
      if (ok) pushRecent(glyph);
      setCaret(null);
    },
    [trigger, fieldRef, onValueChange, maxLength, onAfter, value],
  );

  /** For the picker button: insert at the caret, then hide any suggestion list. */
  const insertEmoji = useCallback(
    (glyph: string) => {
      insertAtCursor(fieldRef.current, glyph, onValueChange, { maxLength, onAfter, fallbackValue: value });
      setCaret(null);
    },
    [fieldRef, onValueChange, maxLength, onAfter, value],
  );

  const handleChange = useCallback(
    (e: ChangeEvent<Field>) => {
      const el = e.target;
      const next = el.value;
      const pos = el.selectionStart ?? next.length;
      const typed = (e.nativeEvent as InputEvent).data;
      if (enabled && typed === ":") {
        ensureData();
        const loaded = getLoadedEmojiData();
        const done = loaded
          ? expandClosedShortcode(next, pos, (code) => {
              const hit = loaded.byShortcode.get(code);
              return hit ? emojiForTone(hit, readTone()) : undefined;
            })
          : null;
        if (done && (maxLength === undefined || done.value.length <= maxLength)) {
          onValueChange(done.value);
          setCaret(null);
          pushRecent(done.emoji);
          requestAnimationFrame(() => {
            el.setSelectionRange(done.caret, done.caret);
            onAfter?.();
          });
          return;
        }
      }
      onValueChange(next);
      setCaret(pos);
      if (enabled && parseEmojiTrigger(next, pos)) ensureData();
    },
    [enabled, ensureData, maxLength, onValueChange, onAfter],
  );

  const handleSelect = useCallback((e: SyntheticEvent<Field>) => {
    const el = e.currentTarget;
    setCaret(el.selectionStart !== null && el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  }, []);

  const handleBlur = useCallback(() => setCaret(null), []);

  /** Returns true when the key was used (the caller must then skip its own handling). */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<Field>): boolean => {
      if (!open || e.nativeEvent.isComposing) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setSel({ key: queryKey, index: (index + step + items.length) % items.length });
        return true;
      }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if ((e.key === "Enter" || e.key === "Tab") && plain) {
        e.preventDefault();
        pick(items[index]);
        return true;
      }
      if (e.key === "Escape") {
        // Escape edits the box; it must not also close a surrounding dialog or panel.
        e.stopPropagation();
        setDismissedKey(queryKey);
        return true;
      }
      return false;
    },
    [open, queryKey, index, items, pick],
  );

  const suggestions: ReactNode = open ? (
    <EmojiSuggestions
      items={items}
      query={trigger?.query ?? ""}
      selectedIndex={index}
      tone={readTone()}
      onPick={pick}
      onHover={(i) => setSel({ key: queryKey, index: i })}
    />
  ) : null;

  return { handleChange, handleKeyDown, handleSelect, handleBlur, insertEmoji, suggestions, open };
}
