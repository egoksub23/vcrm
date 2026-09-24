// Splits a Sembang message body into plain-text and fenced-code-block
// segments, so the renderer can run mention-highlighting only within the
// text segments and syntax-highlighting only within the code segments.
// Pure and total: any input (including an odd number of ``` fences, or no
// fences at all) returns a valid segment list, never throws.
//
// Recognised form: ```lang\ncode\n``` — the optional language tag is a
// single word (letters/digits/+/-) immediately after the opening fence,
// on its own line. ```code``` with no language, or code with no trailing
// newline before the closing fence, both still parse fine.

export interface TextSegment {
  type: "text";
  content: string;
}

export interface CodeSegment {
  type: "code";
  content: string;
  lang?: string;
}

export type MessageSegment = TextSegment | CodeSegment;

const FENCE = "```";
const LANG_TAG = /^[\w+-]+$/;

export function parseCodeBlocks(body: string): MessageSegment[] {
  if (!body) return [];

  const segments: MessageSegment[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const start = body.indexOf(FENCE, cursor);
    if (start === -1) {
      segments.push({ type: "text", content: body.slice(cursor) });
      break;
    }
    if (start > cursor) {
      segments.push({ type: "text", content: body.slice(cursor, start) });
    }

    const afterFence = start + FENCE.length;
    const end = body.indexOf(FENCE, afterFence);
    if (end === -1) {
      // Unterminated fence — render the rest (including the stray
      // backticks) as plain text rather than swallowing the message.
      segments.push({ type: "text", content: body.slice(start) });
      break;
    }

    let inner = body.slice(afterFence, end);
    let lang: string | undefined;
    const newlineIdx = inner.indexOf("\n");
    if (newlineIdx !== -1) {
      const firstLine = inner.slice(0, newlineIdx);
      if (firstLine.length > 0 && LANG_TAG.test(firstLine)) {
        lang = firstLine;
        inner = inner.slice(newlineIdx + 1);
      }
    }
    // Drop exactly one trailing newline before the closing fence — the
    // common shape when a person types a fence on its own line.
    if (inner.endsWith("\n")) inner = inner.slice(0, -1);

    segments.push({ type: "code", content: inner, lang });
    cursor = end + FENCE.length;
  }

  return segments;
}
