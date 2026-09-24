// Rich-text-lite (P3): parses `**bold**`, `_italic_`, and `- ` line-prefixed
// lists inside a single TEXT segment already produced by `parseCodeBlocks`
// (never applied inside a code segment). Runs BETWEEN `parseCodeBlocks` and
// `highlightMentions` in message-body.tsx — for each resulting
// `FormatSegment`, the renderer runs `highlightMentions` on its own text and
// wraps the output in the matching element (`<span>`/`<strong>`/`<em>`, or
// groups consecutive "list" items into a `<ul>`). Neither `parseCodeBlocks`
// nor `highlightMentions`'s own signatures change.
//
// Pure and total: any input (including unmatched `**`/`_` delimiters, or no
// formatting at all) returns a valid segment list, never throws. Kept
// deliberately simple — list items are not themselves re-parsed for nested
// bold/italic, mirroring the "keep it simple" note in SPEC-P3.md's frontend
// item 6.

export type FormatSegment =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "list"; items: string[] };

const LIST_PREFIX = /^- (.*)$/;
// `**bold**` / `_italic_` — same regex-per-line, exec-in-a-loop shape
// `highlightMentions` itself uses, so the two stay easy to compare. Bold
// only matches non-empty `**...**` with no inner newline, italic the same
// for single underscores (an inner `*`/`_` is disallowed so `**a_b**`
// still resolves as one bold run, not a nested/overlapping match).
const INLINE_RE = /\*\*([^*\n]+)\*\*|_([^_\n]+)_/g;

function parseInlineRuns(line: string): FormatSegment[] {
  if (!line) return [];
  const runs: FormatSegment[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) runs.push({ type: "text", text: line.slice(last, start) });
    if (m[1] !== undefined) runs.push({ type: "bold", text: m[1] });
    else if (m[2] !== undefined) runs.push({ type: "italic", text: m[2] });
    last = start + m[0].length;
  }
  if (last < line.length) runs.push({ type: "text", text: line.slice(last) });
  return runs;
}

export function parseInlineFormatting(text: string): FormatSegment[] {
  if (!text) return [];

  const lines = text.split("\n");
  const segments: FormatSegment[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length > 0) {
      segments.push({ type: "list", items: listBuffer });
      listBuffer = [];
    }
  };

  lines.forEach((line, i) => {
    const listMatch = LIST_PREFIX.exec(line);
    if (listMatch) {
      listBuffer.push(listMatch[1]);
      return;
    }
    flushList();
    segments.push(...parseInlineRuns(line));
    if (i < lines.length - 1) segments.push({ type: "text", text: "\n" });
  });
  flushList();

  return segments;
}
