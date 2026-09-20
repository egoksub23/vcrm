/**
 * The ":" shortcut. Typing `:` and then two or more shortcode characters
 * (":smi", ":+1") suggests emoji; a finished ":smile:" turns into the emoji.
 *
 * The colon has to start the text or follow whitespace or an opening
 * punctuation mark. That keeps "10:30", "https://x", "a:b" and "::" from
 * ever triggering.
 */

/** Characters allowed right before the opening colon (besides start of text / whitespace). */
const BEFORE = String.raw`\s(\[{"'“‘,;!?`;
const NAME = String.raw`[A-Za-z0-9_+-]{2,32}`;

const OPEN_RE = new RegExp(String.raw`(^|[${BEFORE}]):(${NAME})$`);
const CLOSED_RE = new RegExp(String.raw`(^|[${BEFORE}]):(${NAME}):$`);

export interface EmojiTrigger {
  /** Index of the opening ":" in the text. */
  start: number;
  /** What was typed after the colon ("smi"). */
  query: string;
}

/** The open `:query` that ends exactly at the caret, or null. */
export function parseEmojiTrigger(text: string, caret: number): EmojiTrigger | null {
  const before = text.slice(0, caret);
  const m = OPEN_RE.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

export interface ClosedShortcodeResult {
  value: string;
  caret: number;
  emoji: string;
}

/**
 * When the caret sits right after the closing colon of a known ":shortcode:",
 * returns the text with it replaced by the emoji. `resolve` maps a lower-case
 * shortcode to its emoji (or undefined), so an unknown ":foo:" is left alone.
 */
export function expandClosedShortcode(
  text: string,
  caret: number,
  resolve: (shortcode: string) => string | undefined,
): ClosedShortcodeResult | null {
  const before = text.slice(0, caret);
  const m = CLOSED_RE.exec(before);
  if (!m) return null;
  const emoji = resolve(m[2].toLowerCase());
  if (!emoji) return null;
  const start = before.length - m[2].length - 2;
  return {
    value: text.slice(0, start) + emoji + text.slice(caret),
    caret: start + emoji.length,
    emoji,
  };
}
