import { Marked, Renderer, type Token, type Tokens } from "marked";
import type { HelpHeading } from "./types";

// Markdown -> HTML for the User Guide. Pure (no fs, no React) so it is easy to
// test. Content is repo-authored and trusted, but nothing here can run script:
//   - raw HTML is reduced to a small allow-list of tags with NO attributes,
//   - link and image URLs are limited to http(s), mailto, tel and site paths,
//   - everything else is escaped.
// Problems are collected in `warnings` (and the content test fails on them).

export interface MarkdownLabels {
  copyCode: string;
  copied: string;
  /** Contains "{alt}". */
  zoomImage: string;
  linkToSection: string;
  /** Contains "{file}". Shown in the placeholder when a screenshot is missing. */
  imageMissing: string;
  callouts: { note: string; tip: string; warning: string; important: string };
}

export const DEFAULT_LABELS: MarkdownLabels = {
  copyCode: "Copy",
  copied: "Copied",
  zoomImage: "Zoom image: {alt}",
  linkToSection: "Link to this section",
  imageMissing: "Screenshot not added yet: {file}",
  callouts: { note: "Note", tip: "Tip", warning: "Warning", important: "Important" },
};

export interface RenderOptions {
  labels?: Partial<MarkdownLabels>;
  /**
   * Tell the renderer whether a local image exists (for the placeholder).
   * Return undefined when unknown; the image is then rendered normally.
   */
  imageExists?: (src: string) => boolean | undefined;
  /** Show the missing file name in the placeholder (development). */
  showMissingFileName?: boolean;
}

export interface RenderedMarkdown {
  html: string;
  headings: HelpHeading[];
  /** Plain text of the body, for search. */
  text: string;
  /** Every link target found (as written). */
  links: string[];
  /** Every image src found (as written). */
  images: string[];
  warnings: string[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** GitHub-like heading slug. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

// Lucide icon shapes (info, lightbulb, triangle-alert, octagon-alert), inlined
// because the HTML is built as a string.
const ICONS = {
  note: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  tip: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  warning:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  important:
    '<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>',
} as const;

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

type CalloutKind = keyof typeof ICONS;

const CALLOUT_ALIASES: Record<string, CalloutKind> = {
  NOTE: "note",
  TIP: "tip",
  WARNING: "warning",
  IMPORTANT: "important",
  // GitHub also has CAUTION; treat it as a warning.
  CAUTION: "warning",
};

const CALLOUT_MARKER = /^\[!([A-Za-z]+)\][ \t]*\n?/;

// Raw HTML the guide may contain. No attributes are ever kept.
const ALLOWED_TAGS = new Set([
  "kbd",
  "br",
  "sup",
  "sub",
  "mark",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "code",
  "small",
  "details",
  "summary",
]);
// Stands in for "<" on tags that passed the allow-list.
const MARK = "\u0001";
const VOID_TAGS = new Set(["br"]);
// Blocks whose CONTENT must not survive either.
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi;

function sanitizeHtml(html: string, warnings: string[]): string {
  let out = html.replace(new RegExp(MARK, "g"), "").replace(DROP_WITH_CONTENT, () => {
    warnings.push("removed an unsafe HTML block (script, style, iframe, object or embed)");
    return "";
  });
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_m, slash: string, name: string) => {
    const tag = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      warnings.push(`removed unsupported HTML tag <${tag}>`);
      return "";
    }
    if (VOID_TAGS.has(tag)) return slash ? "" : `${MARK}${tag}>`;
    return `${MARK}${slash}${tag}>`;
  });
  // Anything that still looks like a tag opener (unterminated) becomes text.
  // (kept tags are written with a private marker instead of "<" so they survive this).
  return out.replace(/</g, "&lt;").replace(new RegExp(MARK, "g"), "<");
}

type UrlKind = "internal" | "external" | "mailto" | "anchor" | "bad";

function classifyUrl(href: string): UrlKind {
  const h = href.trim();
  if (!h) return "bad";
  if (h.startsWith("#")) return "anchor";
  if (h.startsWith("//")) return "bad";
  if (h.startsWith("/")) return "internal";
  if (/^https?:\/\//i.test(h)) return "external";
  if (/^(mailto|tel):/i.test(h)) return "mailto";
  return "bad";
}

function inlineText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "image":
        out += t.text ?? "";
        break;
      case "html":
      case "br":
      case "space":
      case "hr":
        break;
      case "codespan":
      case "escape":
        out += t.text;
        break;
      default:
        if ("tokens" in t && Array.isArray(t.tokens)) out += inlineText(t.tokens as Token[]);
        else if ("text" in t && typeof t.text === "string") out += decodeEntities(t.text);
    }
  }
  return out;
}

/** Plain text of block tokens, for the search index. */
function blockText(tokens: Token[]): string {
  const parts: string[] = [];
  const walk = (list: Token[]) => {
    for (const t of list) {
      switch (t.type) {
        case "code":
          parts.push(t.text);
          break;
        case "list":
          for (const item of (t as Tokens.List).items) walk(item.tokens);
          break;
        case "table": {
          const table = t as Tokens.Table;
          parts.push(table.header.map((c) => inlineText(c.tokens)).join(" "));
          for (const row of table.rows) parts.push(row.map((c) => inlineText(c.tokens)).join(" "));
          break;
        }
        case "blockquote":
          walk((t as Tokens.Blockquote).tokens);
          break;
        case "heading":
        case "paragraph":
        case "text": {
          const tt = t as Tokens.Heading | Tokens.Paragraph | Tokens.Text;
          if (tt.tokens && tt.tokens.length) parts.push(inlineText(tt.tokens));
          else parts.push(decodeEntities(tt.text));
          break;
        }
        default:
          break;
      }
    }
  };
  walk(tokens);
  return parts
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function renderMarkdown(source: string, options: RenderOptions = {}): RenderedMarkdown {
  const labels: MarkdownLabels = {
    ...DEFAULT_LABELS,
    ...options.labels,
    callouts: { ...DEFAULT_LABELS.callouts, ...options.labels?.callouts },
  };
  const warnings: string[] = [];
  const headings: HelpHeading[] = [];
  const links: string[] = [];
  const images: string[] = [];
  const usedIds = new Map<string, number>();

  const uniqueId = (text: string): string => {
    const base = slugify(text);
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      heading(this: Renderer, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        // The page title is the h1, so a "#" inside the body renders as h2.
        const level = Math.min(6, Math.max(2, depth));
        if (level > 3) return `<h${level}>${inner}</h${level}>\n`;
        const text = inlineText(tokens).trim();
        const id = uniqueId(text);
        headings.push({ id, text, depth: level as 2 | 3 });
        const anchor = `<a class="help-anchor" href="#${id}" aria-label="${escapeHtml(labels.linkToSection)}">#</a>`;
        return `<h${level} id="${id}">${inner}${anchor}</h${level}>\n`;
      },

      html({ text }: Tokens.HTML | Tokens.Tag) {
        return sanitizeHtml(text, warnings);
      },

      code({ text, lang }: Tokens.Code) {
        const language = (lang ?? "").trim().split(/\s+/)[0].replace(/[^A-Za-z0-9+#_-]/g, "");
        const cls = language ? ` class="language-${language}"` : "";
        const button =
          `<button type="button" class="help-copy" data-help-copy data-label-copied="${escapeHtml(labels.copied)}">` +
          `${escapeHtml(labels.copyCode)}</button>`;
        return `<div class="help-code">${button}<pre><code${cls}>${escapeHtml(text)}</code></pre></div>\n`;
      },

      table(this: Renderer, token: Tokens.Table) {
        const html = Renderer.prototype.table.call(this, token);
        return `<div class="help-table-wrap">${html}</div>\n`;
      },

      list(this: Renderer, token: Tokens.List) {
        const html = Renderer.prototype.list.call(this, token);
        return token.ordered ? html.replace(/^<ol/, '<ol class="help-steps"') : html;
      },

      link(this: Renderer, { href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        links.push(href);
        const kind = classifyUrl(href);
        if (kind === "bad") {
          warnings.push(`removed a link with an unsupported address: ${href}`);
          return text;
        }
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        const external = kind === "external" ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${escapeHtml(href.trim())}"${t}${external}>${text}</a>`;
      },

      image({ href, text }: Tokens.Image) {
        images.push(href);
        const alt = decodeEntities(text ?? "");
        const kind = classifyUrl(href);
        if (kind !== "internal" && kind !== "external") {
          warnings.push(`removed an image with an unsupported address: ${href}`);
          return "";
        }
        const caption = alt ? `<span class="help-caption">${escapeHtml(alt)}</span>` : "";
        const exists = options.imageExists?.(href);
        if (exists === false) {
          const file = href.split("/").pop() ?? href;
          const note = options.showMissingFileName
            ? escapeHtml(labels.imageMissing.replace("{file}", file))
            : "";
          return (
            `<span class="help-figure help-figure-missing" role="img" aria-label="${escapeHtml(alt)}" data-missing="${escapeHtml(file)}">` +
            `<span class="help-missing-box"><span class="help-missing-icon" aria-hidden="true"></span>` +
            `${note ? `<span class="help-missing-note">${note}</span>` : ""}</span>${caption}</span>`
          );
        }
        const zoom = escapeHtml(labels.zoomImage.replace("{alt}", alt));
        return (
          `<span class="help-figure">` +
          `<button type="button" class="help-zoom" data-help-zoom aria-label="${zoom}">` +
          `<img src="${escapeHtml(href.trim())}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">` +
          `</button>${caption}</span>`
        );
      },

      blockquote(this: Renderer, { tokens }: Tokens.Blockquote) {
        const first = tokens[0];
        if (first && first.type === "paragraph") {
          const para = first as Tokens.Paragraph;
          const m = CALLOUT_MARKER.exec(para.text);
          if (m) {
            const kind = CALLOUT_ALIASES[m[1].toUpperCase()];
            const lead = para.tokens[0];
            if (kind && lead && lead.type === "text" && CALLOUT_MARKER.test((lead as Tokens.Text).text)) {
              const t = lead as Tokens.Text;
              const rest = t.text.replace(CALLOUT_MARKER, "");
              if (rest) {
                t.text = rest;
                t.raw = rest;
              } else {
                para.tokens.shift();
              }
              const body = para.tokens.length ? tokens : tokens.slice(1);
              const title = labels.callouts[kind];
              return (
                `<aside class="help-callout" data-callout="${kind}" role="note">` +
                `<div class="help-callout-title">${SVG_OPEN}${ICONS[kind]}</svg><span>${escapeHtml(title)}</span></div>` +
                `<div class="help-callout-body">${this.parser.parse(body)}</div></aside>\n`
              );
            }
            warnings.push(`callout marker [!${m[1]}] is not one of NOTE, TIP, WARNING or IMPORTANT`);
          }
        }
        return Renderer.prototype.blockquote.call(this, { type: "blockquote", raw: "", text: "", tokens });
      },
    },
  });

  const tokens = marked.lexer(source.replace(/\r\n?/g, "\n"));
  const html = marked.parser(tokens);
  return {
    html,
    headings,
    text: blockText(tokens),
    links,
    images,
    warnings: Array.from(new Set(warnings)),
  };
}
