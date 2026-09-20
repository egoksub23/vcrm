// ============================================================
// Atlassian Document Format (ADF) converter.
//
//   Vircle text / simple HTML  ->  ADF   (paragraphs, bold, italic, code,
//                                          links, lists, code blocks, quotes)
//   ADF                        ->  plain text, or sanitised HTML
//
// Text that comes FROM Jira is untrusted. Nothing here ever returns raw
// HTML from the input: the plain-text form is what the ticket stores and
// renders, and the HTML form escapes every character and only emits a fixed
// allow-list of tags and http / https / mailto links.
//
// Jira caps a description or comment at 32,767 characters; `limitAdf` cuts a
// document there and appends a "see the full text in Vircle" link.
//
// Pure, no I/O.
// ============================================================

import { JIRA_TEXT_MAX } from "./types";

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
}
export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

const MAX_DEPTH = 40;
const MAX_NODES = 20_000;

export const emptyDoc = (): AdfDoc => ({ version: 1, type: "doc", content: [] });

const para = (content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const textNode = (text: string, marks?: AdfMark[]): AdfNode =>
  marks && marks.length > 0 ? { type: "text", text, marks } : { type: "text", text };

// ------------------------------------------------------------
// Links
// ------------------------------------------------------------

/** Only http, https and mailto links are ever kept (no javascript:, data: ...). */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const h = href.trim();
  if (h.length === 0 || h.length > 2000) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(h)) return null;
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

const linkMark = (href: string): AdfMark => ({ type: "link", attrs: { href } });

// ------------------------------------------------------------
// Plain text -> ADF
// ------------------------------------------------------------

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(?<![\w*])\*([^*\s][^*\n]*)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*)_(?![\w_])|(https?:\/\/[^\s<>"')\]]+)/g;

/** Inline text with `code`, **bold**, *italic* and bare links. */
export function inlineToAdf(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  let last = 0;
  const push = (t: string, marks?: AdfMark[]) => {
    if (t) out.push(textNode(t, marks));
  };
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    push(text.slice(last, at));
    if (m[1]) push(m[1].slice(1, -1), [{ type: "code" }]);
    else if (m[2]) push(m[2].slice(2, -2), [{ type: "strong" }]);
    else if (m[3]) push(m[3], [{ type: "em" }]);
    else if (m[4]) push(m[4], [{ type: "em" }]);
    else if (m[5]) {
      // A trailing full stop or comma belongs to the sentence, not the address.
      const url = m[5].replace(/[.,;:!?]+$/, "");
      const href = safeHref(url);
      if (href) push(url, [linkMark(href)]);
      else push(url);
      push(m[5].slice(url.length));
    }
    last = at + m[0].length;
  }
  push(text.slice(last));
  return out;
}

function withBreaks(lines: string[]): AdfNode[] {
  const out: AdfNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: "hardBreak" });
    out.push(...inlineToAdf(line));
  });
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

/** What an agent types (a textarea): blank-line paragraphs, `- ` lists, ``` fences. */
export function textToAdf(input: string): AdfDoc {
  const lines = String(input ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: AdfNode[] = [];
  let buf: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: string[] | null = null;

  const flushPara = () => {
    if (buf.length > 0) blocks.push(para(withBreaks(buf)));
    buf = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      type: list.ordered ? "orderedList" : "bulletList",
      content: list.items.map((item) => ({ type: "listItem", content: [para(inlineToAdf(item))] })),
    });
    list = null;
  };

  for (const line of lines) {
    if (fence) {
      if (FENCE.test(line)) {
        blocks.push({ type: "codeBlock", content: fence.length ? [textNode(fence.join("\n"))] : [] });
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (FENCE.test(line)) {
      flushPara();
      flushList();
      fence = [];
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      const isOrdered = !!ordered;
      if (list && list.ordered !== isOrdered) flushList();
      if (!list) list = { ordered: isOrdered, items: [] };
      list.items.push((bullet ?? ordered)![1]);
      continue;
    }
    flushList();
    buf.push(line);
  }
  if (fence) blocks.push({ type: "codeBlock", content: fence.length ? [textNode(fence.join("\n"))] : [] });
  flushPara();
  flushList();
  return { version: 1, type: "doc", content: blocks };
}

// ------------------------------------------------------------
// Simple HTML -> ADF
// ------------------------------------------------------------

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  text?: string;
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "head", "title"]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of src.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  let count = 0;
  let skipUntil: string | null = null;

  for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</g)) {
    if (++count > MAX_NODES) break;
    const raw = token[0];
    const top = stack[stack.length - 1];

    if (raw.startsWith("<!--")) continue;
    if (raw[0] !== "<" || raw === "<") {
      if (skipUntil) continue;
      top.children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(raw) });
      continue;
    }
    const closing = raw[1] === "/";
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();

    if (skipUntil) {
      if (closing && tag === skipUntil) skipUntil = null;
      continue;
    }
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!raw.endsWith("/>")) skipUntil = tag;
      continue;
    }
    const node: HtmlNode = { tag, attrs: parseAttrs(raw.slice(nameMatch[0].length, -1)), children: [] };
    top.children.push(node);
    if (!VOID.has(tag) && !raw.endsWith("/>") && stack.length < MAX_DEPTH) stack.push(node);
  }
  return root;
}

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "blockquote", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "dl", "dt", "dd",
]);

const mergeMarks = (marks: AdfMark[], add: AdfMark): AdfMark[] =>
  marks.some((m) => m.type === add.type) ? marks : [...marks, add];

function inlineOf(nodes: HtmlNode[], marks: AdfMark[], out: AdfNode[]): void {
  for (const n of nodes) {
    if (n.tag === "#text") {
      const t = (n.text ?? "").replace(/\s+/g, " ");
      if (t) out.push(textNode(t, marks));
    } else if (n.tag === "br") {
      out.push({ type: "hardBreak" });
    } else if (n.tag === "strong" || n.tag === "b") {
      inlineOf(n.children, mergeMarks(marks, { type: "strong" }), out);
    } else if (n.tag === "em" || n.tag === "i") {
      inlineOf(n.children, mergeMarks(marks, { type: "em" }), out);
    } else if (n.tag === "u") {
      inlineOf(n.children, mergeMarks(marks, { type: "underline" }), out);
    } else if (n.tag === "s" || n.tag === "del" || n.tag === "strike") {
      inlineOf(n.children, mergeMarks(marks, { type: "strike" }), out);
    } else if (n.tag === "code" || n.tag === "kbd" || n.tag === "samp") {
      // The code mark may only sit next to a link mark in ADF.
      inlineOf(n.children, [...marks.filter((m) => m.type === "link"), { type: "code" }], out);
    } else if (n.tag === "a") {
      const href = safeHref(n.attrs.href);
      inlineOf(n.children, href ? mergeMarks(marks.filter((m) => m.type !== "link"), linkMark(href)) : marks, out);
    } else {
      inlineOf(n.children, marks, out);
    }
  }
}

/** Trim and drop nodes that would make an empty or space-only paragraph. */
function tidyInline(nodes: AdfNode[]): AdfNode[] {
  const out = [...nodes];
  while (out.length && out[0].type === "text" && (out[0].text ?? "").trim() === "" ) out.shift();
  while (out.length && out[out.length - 1].type === "text" && (out[out.length - 1].text ?? "").trim() === "") out.pop();
  while (out.length && out[out.length - 1].type === "hardBreak") out.pop();
  if (out.length && out[0].type === "text") out[0] = { ...out[0], text: (out[0].text ?? "").replace(/^\s+/, "") };
  const last = out.length - 1;
  if (last >= 0 && out[last].type === "text") out[last] = { ...out[last], text: (out[last].text ?? "").replace(/\s+$/, "") };
  return out.filter((n) => n.type !== "text" || (n.text ?? "") !== "");
}

function plainOf(nodes: HtmlNode[]): string {
  return nodes.map((n) => (n.tag === "#text" ? (n.text ?? "") : n.tag === "br" ? "\n" : plainOf(n.children))).join("");
}

function blocksOf(nodes: HtmlNode[], depth = 0): AdfNode[] {
  const out: AdfNode[] = [];
  let inline: HtmlNode[] = [];
  const flush = () => {
    if (inline.length === 0) return;
    const nodesOut: AdfNode[] = [];
    inlineOf(inline, [], nodesOut);
    const tidy = tidyInline(nodesOut);
    if (tidy.length > 0) out.push(para(tidy));
    inline = [];
  };
  if (depth > MAX_DEPTH) return out;

  for (const n of nodes) {
    if (n.tag === "#text" || !BLOCK_TAGS.has(n.tag)) {
      inline.push(n);
      continue;
    }
    flush();
    switch (n.tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const c: AdfNode[] = [];
        inlineOf(n.children, [], c);
        const tidy = tidyInline(c);
        if (tidy.length) out.push({ type: "heading", attrs: { level: Number(n.tag[1]) }, content: tidy });
        break;
      }
      case "ul": case "ol": {
        const items = n.children
          .filter((c) => c.tag === "li")
          .map((li): AdfNode => {
            const content = blocksOf(li.children, depth + 1);
            return { type: "listItem", content: content.length ? content : [para([])] };
          });
        if (items.length) out.push({ type: n.tag === "ol" ? "orderedList" : "bulletList", content: items });
        break;
      }
      case "pre": {
        const text = plainOf(n.children).replace(/^\n/, "").replace(/\n$/, "");
        out.push({ type: "codeBlock", content: text ? [textNode(text)] : [] });
        break;
      }
      case "blockquote": {
        const c = blocksOf(n.children, depth + 1);
        if (c.length) out.push({ type: "blockquote", content: c });
        break;
      }
      case "hr":
        out.push({ type: "rule" });
        break;
      default:
        out.push(...blocksOf(n.children, depth + 1));
    }
  }
  flush();
  return out;
}

/** Simple HTML (what an editor produces) to ADF. Anything unknown is flattened to its text. */
export function htmlToAdf(html: string): AdfDoc {
  const src = String(html ?? "").slice(0, 400_000);
  return { version: 1, type: "doc", content: blocksOf(parseHtml(src).children) };
}

// ------------------------------------------------------------
// Length and truncation
// ------------------------------------------------------------

export function adfTextLength(node: AdfNode | AdfDoc): number {
  if (node.type === "text") return (node as AdfNode).text?.length ?? 0;
  if (node.type === "hardBreak") return 1;
  const kids = (node as AdfNode).content ?? [];
  let n = 0;
  for (const c of kids) n += adfTextLength(c);
  // A block boundary counts as one character, like the newline it becomes.
  return node.type === "doc" || node.type === "paragraph" || node.type === "listItem" || node.type === "codeBlock" ? n + (node.type === "doc" ? 0 : 1) : n;
}

/** Cut text on a code point boundary (never inside a surrogate pair). */
function clip(text: string, n: number): string {
  if (text.length <= n) return text;
  let end = n;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function cutNode(node: AdfNode, budget: number): AdfNode | null {
  if (budget <= 0) return null;
  if (node.type === "text") {
    const t = clip(node.text ?? "", budget);
    return t ? { ...node, text: t } : null;
  }
  if (node.type === "hardBreak") return node;
  if (!node.content) return node;
  const kept: AdfNode[] = [];
  let left = budget;
  for (const c of node.content) {
    const len = adfTextLength(c);
    if (len <= left) {
      kept.push(c);
      left -= len;
    } else {
      const cut = cutNode(c, left);
      if (cut) kept.push(cut);
      break;
    }
  }
  return kept.length ? { ...node, content: kept } : null;
}

export interface LimitOptions {
  max?: number;
  /** Text of the closing "see the full text" line. */
  footerText?: string;
  footerHref?: string | null;
}

/**
 * Cut a document at `max` characters (Jira's 32,767) and end it with a
 * "see the full text in Vircle" line. A document within the limit is
 * returned unchanged.
 */
export function limitAdf(doc: AdfDoc, opts: LimitOptions = {}): { doc: AdfDoc; truncated: boolean } {
  const max = opts.max ?? JIRA_TEXT_MAX;
  if (adfTextLength(doc) <= max) return { doc, truncated: false };

  const footerText = opts.footerText ?? "… See the full text in Vircle";
  const budget = Math.max(0, max - footerText.length - 2);
  const kept: AdfNode[] = [];
  let used = 0;
  for (const block of doc.content) {
    const len = adfTextLength(block);
    if (used + len <= budget) {
      kept.push(block);
      used += len;
      continue;
    }
    const cut = cutNode(block, budget - used);
    if (cut) kept.push(cut);
    break;
  }
  const href = safeHref(opts.footerHref ?? undefined);
  kept.push(para([textNode(footerText, href ? [linkMark(href)] : undefined)]));
  return { doc: { version: 1, type: "doc", content: kept }, truncated: true };
}

// ------------------------------------------------------------
// ADF -> plain text
// ------------------------------------------------------------

function inlineText(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? node.text : "";
    case "hardBreak":
      return "\n";
    case "mention":
      return typeof node.attrs?.text === "string" ? (node.attrs.text as string) : "@user";
    case "emoji":
      return typeof node.attrs?.text === "string"
        ? (node.attrs.text as string)
        : typeof node.attrs?.shortName === "string"
          ? (node.attrs.shortName as string)
          : "";
    case "inlineCard":
    case "blockCard":
    case "embedCard": {
      const url = typeof node.attrs?.url === "string" ? (node.attrs.url as string) : "";
      return safeHref(url) ?? "";
    }
    case "status":
      return typeof node.attrs?.text === "string" ? `[${node.attrs.text as string}]` : "";
    case "date":
      return typeof node.attrs?.timestamp === "string" || typeof node.attrs?.timestamp === "number"
        ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10)
        : "";
    case "media":
    case "mediaInline": {
      const alt = node.attrs?.alt;
      return `[attachment${typeof alt === "string" && alt ? `: ${alt}` : ""}]`;
    }
    default:
      return (node.content ?? []).map((c) => inlineText(c, depth + 1)).join("");
  }
}

function blockText(node: AdfNode, depth: number, indent = ""): string {
  if (depth > MAX_DEPTH) return "";
  const kids = node.content ?? [];
  switch (node.type) {
    case "paragraph":
    case "heading":
      return indent + kids.map((c) => inlineText(c, depth + 1)).join("");
    case "codeBlock":
      return kids.map((c) => inlineText(c, depth + 1)).join("").split("\n").map((l) => indent + "    " + l).join("\n");
    case "rule":
      return `${indent}---`;
    case "bulletList":
    case "orderedList":
      return kids
        .map((li, i) => {
          const marker = node.type === "bulletList" ? "• " : `${i + 1}. `;
          const parts = (li.content ?? []).map((b) => blockText(b, depth + 1, indent + "  ")).filter(Boolean);
          const first = (parts[0] ?? "").slice(indent.length + 2);
          return [`${indent}${marker}${first}`, ...parts.slice(1)].join("\n");
        })
        .join("\n");
    case "blockquote":
    case "panel":
    case "expand":
    case "nestedExpand":
      return kids.map((b) => blockText(b, depth + 1, indent + "> ")).filter(Boolean).join("\n");
    case "table":
      return kids
        .map((row) =>
          (row.content ?? [])
            .map((cell) => (cell.content ?? []).map((b) => blockText(b, depth + 1)).join(" "))
            .join(" | "),
        )
        .join("\n");
    case "mediaSingle":
    case "mediaGroup":
      return kids.map((c) => inlineText(c, depth + 1)).join(" ");
    default:
      // A block we do not know: keep its text, never its markup.
      return kids.some((c) => c.type === "paragraph" || c.type === "bulletList")
        ? kids.map((b) => blockText(b, depth + 1, indent)).filter(Boolean).join("\n\n")
        : kids.map((c) => inlineText(c, depth + 1)).join("");
  }
}

/** Untrusted ADF (from Jira) to plain text. Never throws, always bounded. */
export function adfToPlainText(input: unknown, opts: { max?: number } = {}): string {
  const max = opts.max ?? 100_000;
  if (typeof input === "string") return input.slice(0, max);
  if (!input || typeof input !== "object") return "";
  const doc = input as AdfNode;
  const blocks = Array.isArray(doc.content) ? doc.content : [];
  const text = blocks
    .filter((b) => b && typeof b === "object")
    .map((b) => blockText(b as AdfNode, 0))
    .filter((s) => s.trim() !== "")
    .join("\n\n");
  return text.slice(0, max);
}

// ------------------------------------------------------------
// ADF -> sanitised HTML
// ------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markHtml(text: string, marks: AdfMark[] | undefined): string {
  let out = escapeHtml(text);
  for (const m of marks ?? []) {
    if (m.type === "strong") out = `<strong>${out}</strong>`;
    else if (m.type === "em") out = `<em>${out}</em>`;
    else if (m.type === "code") out = `<code>${out}</code>`;
    else if (m.type === "strike") out = `<s>${out}</s>`;
    else if (m.type === "underline") out = `<u>${out}</u>`;
    else if (m.type === "link") {
      const href = safeHref(m.attrs?.href);
      if (href) out = `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${out}</a>`;
    }
  }
  return out;
}

function inlineHtml(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  if (node.type === "text") return markHtml(typeof node.text === "string" ? node.text : "", node.marks);
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "mention" || node.type === "emoji" || node.type === "status" || node.type === "date" || node.type === "media" || node.type === "mediaInline") {
    return escapeHtml(inlineText(node, depth));
  }
  if (node.type === "inlineCard" || node.type === "blockCard" || node.type === "embedCard") {
    const href = safeHref(node.attrs?.url);
    return href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(href)}</a>` : "";
  }
  return (node.content ?? []).map((c) => inlineHtml(c, depth + 1)).join("");
}

function blockHtml(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  const kids = node.content ?? [];
  const inner = () => kids.map((c) => inlineHtml(c, depth + 1)).join("");
  switch (node.type) {
    case "paragraph":
      return `<p>${inner()}</p>`;
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `<h${level}>${inner()}</h${level}>`;
    }
    case "codeBlock":
      return `<pre><code>${escapeHtml(kids.map((c) => inlineText(c, depth + 1)).join(""))}</code></pre>`;
    case "rule":
      return "<hr>";
    case "bulletList":
      return `<ul>${kids.map((li) => `<li>${(li.content ?? []).map((b) => blockHtml(b, depth + 1)).join("")}</li>`).join("")}</ul>`;
    case "orderedList":
      return `<ol>${kids.map((li) => `<li>${(li.content ?? []).map((b) => blockHtml(b, depth + 1)).join("")}</li>`).join("")}</ol>`;
    case "blockquote":
    case "panel":
    case "expand":
    case "nestedExpand":
      return `<blockquote>${kids.map((b) => blockHtml(b, depth + 1)).join("")}</blockquote>`;
    default: {
      const text = blockText(node, depth);
      return text.trim() ? `<p>${escapeHtml(text)}</p>` : "";
    }
  }
}

/** Untrusted ADF to escaped HTML with a fixed tag allow-list. */
export function adfToSafeHtml(input: unknown, opts: { max?: number } = {}): string {
  if (!input || typeof input !== "object") return typeof input === "string" ? `<p>${escapeHtml(input)}</p>` : "";
  const doc = input as AdfNode;
  const blocks = Array.isArray(doc.content) ? doc.content : [];
  const html = blocks
    .filter((b) => b && typeof b === "object")
    .map((b) => blockHtml(b as AdfNode, 0))
    .join("");
  return html.slice(0, opts.max ?? 300_000);
}

// ------------------------------------------------------------
// What Vircle sends
// ------------------------------------------------------------

/**
 * The issue description: the ticket text (plain, as typed) then a rule and a
 * link back to the ticket. Cut at Jira's limit with a link to the full text.
 */
export function buildIssueDescription(args: {
  text: string | null | undefined;
  ticketKey: string;
  ticketUrl: string | null;
  extraLines?: string[];
  linkBackLabel?: string;
}): { doc: AdfDoc; truncated: boolean } {
  const body = textToAdf(args.text ?? "");
  const tail: AdfNode[] = [];
  for (const line of args.extraLines ?? []) if (line.trim()) tail.push(para(inlineToAdf(line)));
  const href = safeHref(args.ticketUrl ?? undefined);
  const label = args.linkBackLabel ?? `Vircle ticket ${args.ticketKey}`;
  const footer = para(href ? [textNode(label, [linkMark(href)])] : [textNode(label)]);
  const doc: AdfDoc = {
    version: 1,
    type: "doc",
    content: [...body.content, ...tail, { type: "rule" }, footer],
  };
  // Leave room for the closing link the truncation adds.
  return limitAdf(doc, { max: JIRA_TEXT_MAX - 200, footerHref: args.ticketUrl });
}

/** A comment Vircle posts: "Maya (Vircle): text". */
export function buildVircleComment(args: {
  agentName: string;
  text: string;
  ticketUrl?: string | null;
}): { doc: AdfDoc; truncated: boolean } {
  const name = args.agentName.replace(/\s+/g, " ").trim().slice(0, 80) || "Someone";
  const body = textToAdf(args.text);
  const label = textNode(`${name} (Vircle):`, [{ type: "strong" }]);
  const first = body.content[0];
  let content: AdfNode[];
  if (first && first.type === "paragraph") {
    content = [para([label, textNode(" "), ...(first.content ?? [])]), ...body.content.slice(1)];
  } else {
    content = [para([label]), ...body.content];
  }
  return limitAdf({ version: 1, type: "doc", content }, { footerHref: args.ticketUrl });
}
