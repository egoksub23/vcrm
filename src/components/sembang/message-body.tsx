"use client";

// Renders a Sembang message body: mention-highlighted plain text, plus
// fenced code blocks with highlight.js syntax highlighting. See
// `@/lib/sembang/parse-code-blocks` for the splitter this builds on, and
// `@/lib/tickets/mention-highlight` (already used by channel-thread.tsx in
// P0) for the mention painting re-used unchanged here.
//
// The wrapping element is a `<div>`, not a `<p>` — a `<pre>` (used for a
// code segment) can't legally nest inside a `<p>`.

import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { highlightMentions } from "@/lib/tickets/mention-highlight";
import { parseCodeBlocks } from "@/lib/sembang/parse-code-blocks";
import { parseInlineFormatting, type FormatSegment } from "@/lib/sembang/parse-inline-formatting";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Highlighted via `hljs.highlight()` + `dangerouslySetInnerHTML` rather than
 *  a ref + `highlightElement()` effect — simpler, and avoids the "already
 *  highlighted" re-run pitfall on updates. `hljs` always HTML-escapes the
 *  code it tokenizes, so this never re-introduces markup from the message
 *  body; the try/catch is only a last-resort safety net (an unknown/broken
 *  language must still render as plain monospace text, never throw). */
function CodeBlock({ content, lang }: { content: string; lang?: string }) {
  let html: string;
  let className = "hljs";
  try {
    if (lang && hljs.getLanguage(lang)) {
      html = hljs.highlight(content, { language: lang }).value;
      className = `hljs language-${lang}`;
    } else {
      html = hljs.highlightAuto(content).value;
    }
  } catch {
    html = escapeHtml(content);
  }
  return (
    <pre className="my-1.5 overflow-x-auto rounded-lg bg-[#0d1117] p-3 text-xs leading-relaxed">
      <code className={className} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

/** Runs `highlightMentions` on one format segment's plain text and wraps the
 *  resulting mention-chip spans in whatever element that segment's own
 *  formatting calls for (`<span>`/`<strong>`/`<em>`, or a `<ul>` of `<li>`s
 *  for a "list" segment — see `parseInlineFormatting`). */
function FormatSegmentView({
  segment,
  peopleNames,
  keyPrefix,
}: {
  segment: FormatSegment;
  peopleNames: string[];
  keyPrefix: string;
}) {
  const renderMentions = (text: string, keyBase: string) =>
    highlightMentions(text, peopleNames, []).map((s, j) =>
      s.kind === "text" ? (
        <span key={`${keyBase}-${j}`}>{s.text}</span>
      ) : (
        <span key={`${keyBase}-${j}`} className="rounded-sm bg-primary/15 px-0.5">
          {s.text}
        </span>
      ),
    );

  if (segment.type === "list") {
    return (
      <ul key={keyPrefix} className="my-1 list-disc pl-5">
        {segment.items.map((item, i) => (
          <li key={i}>{renderMentions(item, `${keyPrefix}-${i}`)}</li>
        ))}
      </ul>
    );
  }
  if (segment.type === "bold") {
    return (
      <strong key={keyPrefix} className="font-semibold">
        {renderMentions(segment.text, keyPrefix)}
      </strong>
    );
  }
  if (segment.type === "italic") {
    return <em key={keyPrefix}>{renderMentions(segment.text, keyPrefix)}</em>;
  }
  return <span key={keyPrefix}>{renderMentions(segment.text, keyPrefix)}</span>;
}

export function MessageBody({ body, peopleNames }: { body: string; peopleNames: string[] }) {
  const segments = parseCodeBlocks(body);
  return (
    <div className="text-sm whitespace-pre-wrap break-words text-foreground">
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlock key={i} content={seg.content} lang={seg.lang} />
        ) : (
          parseInlineFormatting(seg.content).map((fseg, j) => (
            <FormatSegmentView key={`${i}-${j}`} segment={fseg} peopleNames={peopleNames} keyPrefix={`${i}-${j}`} />
          ))
        ),
      )}
    </div>
  );
}
