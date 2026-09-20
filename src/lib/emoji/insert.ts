import type { Editor } from "@tiptap/react";

export interface SpliceResult {
  value: string;
  /** Caret position (UTF-16 index) right after the inserted text. */
  caret: number;
}

/**
 * Replaces `[start, end)` of `value` with `insert`. Indexes are UTF-16 units, as
 * `selectionStart` reports them, so an emoji outside the BMP (a surrogate pair)
 * moves the caret by two. Returns null when the result would be longer than
 * `maxLength` (a programmatic edit is not stopped by the textarea's own limit).
 */
export function spliceText(
  value: string,
  start: number,
  end: number,
  insert: string,
  maxLength?: number,
): SpliceResult | null {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  const next = value.slice(0, s) + insert + value.slice(e);
  if (maxLength !== undefined && next.length > maxLength) return null;
  return { value: next, caret: s + insert.length };
}

export interface InsertOptions {
  /** The field's character limit, if it has one. */
  maxLength?: number;
  /** Runs after the value is set and the caret restored (e.g. auto-grow a textarea). */
  onAfter?: () => void;
}

type TextField = HTMLTextAreaElement | HTMLInputElement;

/** Puts the caret back and focuses the field once React has rendered the new value. */
function restoreCaret(el: TextField | null, caret: number, onAfter?: () => void): void {
  requestAnimationFrame(() => {
    if (el) {
      el.focus();
      el.setSelectionRange(caret, caret);
    }
    onAfter?.();
  });
}

/**
 * Inserts `text` at the caret of a controlled text field (replacing any
 * selection). It calls the state setter directly, which is what React
 * expects, then restores the caret after the inserted text. If the field is not
 * mounted, the text is appended to `fallbackValue`. Returns false if it did not fit.
 */
export function insertAtCursor(
  el: TextField | null,
  text: string,
  setValue: (next: string) => void,
  opts: InsertOptions & { fallbackValue?: string } = {},
): boolean {
  const current = el ? el.value : (opts.fallbackValue ?? "");
  const start = el ? (el.selectionStart ?? current.length) : current.length;
  const end = el ? (el.selectionEnd ?? start) : current.length;
  const res = spliceText(current, start, end, text, opts.maxLength);
  if (!res) return false;
  setValue(res.value);
  restoreCaret(el, res.caret, opts.onAfter);
  return true;
}

/** Replaces `[start, end)` (e.g. the typed ":smi") with `text` and puts the caret after it. */
export function replaceRangeInField(
  el: TextField | null,
  start: number,
  end: number,
  text: string,
  setValue: (next: string) => void,
  opts: InsertOptions & { fallbackValue?: string } = {},
): boolean {
  const current = el ? el.value : (opts.fallbackValue ?? "");
  const res = spliceText(current, start, end, text, opts.maxLength);
  if (!res) return false;
  setValue(res.value);
  restoreCaret(el, res.caret, opts.onAfter);
  return true;
}

/** Inserts an emoji at the selection of a Tiptap editor (the email reply box). */
export function insertEmojiInEditor(editor: Pick<Editor, "chain"> | null | undefined, emoji: string): boolean {
  if (!editor) return false;
  return editor.chain().focus().insertContent(emoji).run();
}
