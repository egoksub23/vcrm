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

export function MessageBody({ body, peopleNames }: { body: string; peopleNames: string[] }) {
  const segments = parseCodeBlocks(body);
  return (
    <div className="text-sm whitespace-pre-wrap break-words text-foreground">
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlock key={i} content={seg.content} lang={seg.lang} />
        ) : (
          highlightMentions(seg.content, peopleNames, []).map((s, j) =>
            s.kind === "text" ? (
              <span key={`${i}-${j}`}>{s.text}</span>
            ) : (
              <span key={`${i}-${j}`} className="rounded-sm bg-primary/15 px-0.5">
                {s.text}
              </span>
            ),
          )
        ),
      )}
    </div>
  );
}
