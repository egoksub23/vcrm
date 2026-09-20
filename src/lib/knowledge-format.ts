import type { ChannelType } from '@/types'

// ============================================================
// Knowledge-base rich text.
//
// An article keeps two bodies: `content_html` (what the editor writes) and
// `content` (plain text, what search and the AI read). This module is the
// one place that moves between them, and the only thing standing between an
// editor's HTML and the customer's inbox, so it is a strict allow-list
// sanitiser with no DOM dependency (it runs in API routes and the browser).
//
// How it works: `parse` turns any string into a small, always well-formed
// tree of allowed elements (unknown tags are dropped but their text kept,
// script/style content is dropped, attributes are dropped except a safe
// <a href>). Serialising that tree gives the sanitised HTML; walking it gives
// plain text or per-channel text. Nothing is ever passed through verbatim.
// ============================================================

type Tag = 'p' | 'h2' | 'h3' | 'ul' | 'ol' | 'li' | 'blockquote' | 'strong' | 'em' | 'u' | 's' | 'a'

interface ElementNode {
  tag: Tag
  href?: string
  children: Node[]
}
interface TextNode {
  tag: '#text'
  text: string
}
interface BreakNode {
  tag: 'br'
}
/** An inline image. `src` is only ever a URL the caller's policy accepted
 *  (see `KbImagePolicy`); `alt` is plain text. */
interface ImageNode {
  tag: 'img'
  src: string
  alt: string
  width?: number
  height?: number
}
type Node = ElementNode | TextNode | BreakNode | ImageNode

/** Decides what an `<img src>` may be: returns the value to keep, or null to
 *  drop the image. `null` (no rule at all) drops every image. */
type ImageRule = ((rawSrc: string) => string | null) | null

const INLINE = new Set<Tag>(['strong', 'em', 'u', 's', 'a'])
const TEXT_BLOCKS = new Set<Tag>(['p', 'h2', 'h3'])
/** Elements that may hold inline content directly. */
const INLINE_HOSTS = new Set<Tag>(['p', 'h2', 'h3', 'li', 'strong', 'em', 'u', 's', 'a'])

/** Renamed to the nearest allowed tag. */
const TAG_ALIASES: Record<string, Tag> = {
  p: 'p',
  h2: 'h2',
  h3: 'h3',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  blockquote: 'blockquote',
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  u: 'u',
  s: 's',
  strike: 's',
  del: 's',
  a: 'a',
  h1: 'h2',
  h4: 'h3',
  h5: 'h3',
  h6: 'h3',
  // Generic blocks from pasted / scraped pages behave as paragraphs.
  div: 'p',
  section: 'p',
  article: 'p',
  header: 'p',
  footer: 'p',
  main: 'p',
  aside: 'p',
  nav: 'p',
  pre: 'p',
  figure: 'p',
  figcaption: 'p',
  tr: 'p',
  dt: 'p',
  dd: 'p',
  address: 'p',
}

/** Elements whose whole content (not just the tag) is discarded. (Void
 *  elements such as <embed> are not listed: they have no content to skip, and
 *  waiting for a closing tag would swallow the rest of the input.) */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'noscript', 'template', 'svg', 'math',
  'head', 'title', 'textarea', 'xmp', 'noembed', 'noframes', 'applet', 'select',
])

const SAFE_HREF = /^(https?:|mailto:|tel:)/i
const MAX_HREF_CHARS = 2000
/** Longest image caption / alt text kept (matches Meta's caption limit). */
export const MAX_IMAGE_ALT_CHARS = 1024
const MAX_IMAGE_DIMENSION = 20000
/** Deeper nesting is not something an editor produces; capping it keeps the
 *  recursive walks below safe from a hostile <blockquote> x 100000. */
const MAX_DEPTH = 40

// ------------------------------------------------------------
// Entities
// ------------------------------------------------------------
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  colon: ':',
  tab: '\t',
  newline: '\n',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
}

function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return ''
  if (cp >= 0xd800 && cp <= 0xdfff) return ''
  // Control characters (other than tab / newline) never belong in text.
  if ((cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp <= 0x9f)) return ''
  return String.fromCodePoint(cp)
}

/** Decode the entities we know; anything else is left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      return codePointToString(n)
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? whole
  })
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00A0/g, '&nbsp;')
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ------------------------------------------------------------
// Tokenizer
// ------------------------------------------------------------
type Token =
  | { t: 'open'; name: string; attrs: Record<string, string> }
  | { t: 'close'; name: string }
  | { t: 'text'; text: string }

const NAME_START = /[a-zA-Z]/
const WS = /\s/

/**
 * Split markup into tags and text. Malformed input never throws and never
 * yields a half-read tag: a tag (or comment) that is not closed before the
 * end of the string is dropped, as a browser would.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  const n = html.length
  let i = 0
  let text = ''
  const flush = () => {
    if (text) tokens.push({ t: 'text', text })
    text = ''
  }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      text += html.slice(i)
      break
    }
    text += html.slice(i, lt)
    i = lt
    const next = html[i + 1]

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      if (end === -1) break
      i = end + 3
      continue
    }
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    if (next === '/' && html[i + 2] !== undefined && NAME_START.test(html[i + 2])) {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(i, i + 80))
      const end = html.indexOf('>', i + 2)
      if (!m || end === -1) break
      flush()
      tokens.push({ t: 'close', name: m[1].toLowerCase() })
      i = end + 1
      continue
    }
    if (next !== undefined && NAME_START.test(next)) {
      let j = i + 1
      while (j < n && !WS.test(html[j]) && html[j] !== '>' && html[j] !== '/') j++
      const name = html.slice(i + 1, j).toLowerCase()
      const attrs: Record<string, string> = {}
      let closed = false
      while (j < n) {
        while (j < n && (WS.test(html[j]) || html[j] === '/')) j++
        if (j >= n) break
        if (html[j] === '>') {
          closed = true
          j++
          break
        }
        const nameStart = j
        while (j < n && !WS.test(html[j]) && html[j] !== '=' && html[j] !== '>' && html[j] !== '/') j++
        const attrName = html.slice(nameStart, j).toLowerCase()
        while (j < n && WS.test(html[j])) j++
        let value = ''
        if (html[j] === '=') {
          j++
          while (j < n && WS.test(html[j])) j++
          const q = html[j]
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1)
            if (end === -1) {
              j = n
              break
            }
            value = html.slice(j + 1, end)
            j = end + 1
          } else {
            const vs = j
            while (j < n && !WS.test(html[j]) && html[j] !== '>') j++
            value = html.slice(vs, j)
          }
        }
        if (attrName && !(attrName in attrs)) attrs[attrName] = value
      }
      if (!closed) break
      i = j
      flush()
      if (DROP_WITH_CONTENT.has(name)) {
        // Skip to the matching close tag; if there is none the rest of the
        // input belonged to the element.
        const re = new RegExp(`</${name}\\s*>`, 'i')
        const m = re.exec(html.slice(i))
        if (!m) return tokens
        i += m.index + m[0].length
        continue
      }
      tokens.push({ t: 'open', name, attrs })
      continue
    }

    // A "<" that starts nothing: literal text.
    text += '<'
    i += 1
  }
  flush()
  return tokens
}

// ------------------------------------------------------------
// Tree building (this is also the normaliser)
// ------------------------------------------------------------
function safeHref(raw: string | undefined): string | null {
  if (!raw) return null
  // Browsers ignore tabs / newlines / spaces inside a scheme, so remove all
  // control characters before judging it.
  const cleaned = decodeEntities(raw).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  if (!cleaned || cleaned.length > MAX_HREF_CHARS) return null
  if (!SAFE_HREF.test(cleaned)) return null
  return cleaned.replace(/ /g, '%20')
}

// ------------------------------------------------------------
// Images
//
// An article may hold `<img>` only when its `src` is a file this account
// uploaded to its own folder of the public chat-media bucket. Nothing else is
// ever let through: not a data: URL, not another host, another account's
// folder, another bucket, a query string, an encoded or `..` path.
// ------------------------------------------------------------

/** Where an account's article images may live. `publicBaseUrl` is the
 *  project's Supabase URL (e.g. `https://abc.supabase.co`). */
export interface KbImagePolicy {
  accountId: string
  publicBaseUrl: string
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** One or more path segments of plain file-name characters (no dot-leading
 *  segment, so no "..", no "%", "?", "#", "\\", "@", ":" or spaces). */
const IMAGE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
const MAX_IMAGE_PATH_CHARS = 300
const MAX_IMAGE_SRC_CHARS = 2000

/** The URL every article image of this account starts with, or null when the
 *  policy is unusable (a bad account id, or a base that is neither https nor
 *  a local development server). */
export function kbImageUrlPrefix(policy: KbImagePolicy | null | undefined): string | null {
  if (!policy || !ACCOUNT_ID.test(policy.accountId)) return null
  let url: URL
  try {
    url = new URL(policy.publicBaseUrl)
  } catch {
    return null
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  if (url.username || url.password) return null
  return `${url.origin}/storage/v1/object/public/chat-media/account-${policy.accountId}/`
}

/** The public URL of an object path in this account's folder (what the
 *  storage API returns for it), or null when the path is not an own-folder
 *  path of plain characters. */
export function kbImageUrlForPath(policy: KbImagePolicy | null | undefined, storagePath: string): string | null {
  const prefix = kbImageUrlPrefix(policy)
  if (!prefix || !policy) return null
  const own = `account-${policy.accountId}/`
  if (!storagePath.startsWith(own)) return null
  const rest = storagePath.slice(own.length)
  if (!isPlainImagePath(rest)) return null
  return `${prefix}${rest}`
}

function isPlainImagePath(rest: string): boolean {
  return rest.length > 0 && rest.length <= MAX_IMAGE_PATH_CHARS && !rest.includes('..') && IMAGE_PATH.test(rest)
}

/** The image `src` to keep, or null. The value must already be exactly the
 *  canonical public URL: nothing is cleaned up on the way (a stray space,
 *  control character or encoded dot is a rejection, not a repair). */
export function safeImageSrc(raw: string | undefined, policy: KbImagePolicy | null | undefined): string | null {
  if (!raw) return null
  const prefix = kbImageUrlPrefix(policy)
  if (!prefix) return null
  const src = decodeEntities(raw)
  if (src.length > MAX_IMAGE_SRC_CHARS || !src.startsWith(prefix)) return null
  return isPlainImagePath(src.slice(prefix.length)) ? src : null
}

/** A rule that keeps an image only when it is this account's own file (and,
 *  when `onlyUrls` is given, one of those files). */
function imageRuleFor(
  policy: KbImagePolicy | null | undefined,
  onlyUrls?: ReadonlySet<string>,
): ImageRule {
  if (!kbImageUrlPrefix(policy)) return null
  return (raw) => {
    const src = safeImageSrc(raw, policy)
    return src !== null && (!onlyUrls || onlyUrls.has(src)) ? src : null
  }
}

/** Accepts every image and keeps the (decoded) src as written. Used only to
 *  READ text out of trusted-shape HTML (alt text, the list of image URLs),
 *  never to produce HTML: the trees built with it are not serialised. */
const READ_ONLY_IMAGES: ImageRule = (raw) => decodeEntities(raw)

function cleanAlt(raw: string | undefined): string {
  if (!raw) return ''
  return decodeEntities(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_IMAGE_ALT_CHARS)
}

function cleanDimension(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,5}$/.test(raw.trim())) return undefined
  const n = parseInt(raw.trim(), 10)
  return n >= 1 && n <= MAX_IMAGE_DIMENSION ? n : undefined
}

function parse(html: string, imageRule: ImageRule = null): Node[] {
  const root: ElementNode = { tag: 'p', children: [] }
  const stack: ElementNode[] = []
  const top = (): ElementNode | null => (stack.length ? stack[stack.length - 1] : null)
  const container = (): Node[] => (top() ? top()!.children : root.children)

  const popTo = (pred: (el: ElementNode) => boolean): boolean => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (pred(stack[k])) {
        stack.length = k
        return true
      }
    }
    return false
  }
  const push = (el: ElementNode) => {
    container().push(el)
    stack.push(el)
  }
  /** True when there is no room left to nest another element. */
  const tooDeep = () => stack.length >= MAX_DEPTH

  /** Make sure inline content has somewhere legitimate to go. */
  const ensureInlineHost = () => {
    const t = top()
    if (t && INLINE_HOSTS.has(t.tag)) return
    if (t && (t.tag === 'ul' || t.tag === 'ol')) {
      push({ tag: 'li', children: [] })
      return
    }
    push({ tag: 'p', children: [] })
  }

  for (const tok of tokenize(html)) {
    if (tok.t === 'text') {
      const decoded = decodeEntities(tok.text).replace(/\r\n?/g, '\n')
      if (!decoded) continue
      if (!decoded.trim()) {
        // Whitespace between blocks is layout, not content.
        const t = top()
        if (!t || !INLINE_HOSTS.has(t.tag)) continue
      } else {
        ensureInlineHost()
      }
      container().push({ tag: '#text', text: decoded })
      continue
    }

    if (tok.t === 'close') {
      if (tok.name === 'br') {
        // "</br>" is a line break to browsers.
        ensureInlineHost()
        container().push({ tag: 'br' })
        continue
      }
      const tag = TAG_ALIASES[tok.name]
      if (tag) popTo((el) => el.tag === tag)
      continue
    }

    // open tag
    if (tok.name === 'br') {
      ensureInlineHost()
      container().push({ tag: 'br' })
      continue
    }
    if (tok.name === 'img') {
      // Only an image the caller's rule accepts; everything else vanishes.
      const src = imageRule ? imageRule(tok.attrs.src ?? '') : null
      if (src === null) continue
      ensureInlineHost()
      const node: ImageNode = { tag: 'img', src, alt: cleanAlt(tok.attrs.alt) }
      const width = cleanDimension(tok.attrs.width)
      const height = cleanDimension(tok.attrs.height)
      if (width !== undefined) node.width = width
      if (height !== undefined) node.height = height
      container().push(node)
      continue
    }
    const tag = TAG_ALIASES[tok.name]
    if (!tag || tooDeep()) continue

    if (INLINE.has(tag)) {
      if (tag === 'a') {
        const href = safeHref(tok.attrs.href)
        // A link we would not keep is just its text.
        if (!href) continue
        popTo((el) => el.tag === 'a') // no nested links
        ensureInlineHost()
        push({ tag: 'a', href, children: [] })
      } else {
        ensureInlineHost()
        push({ tag, children: [] })
      }
      continue
    }

    if (tag === 'li') {
      // An <li> belongs directly inside the nearest list; outside any list
      // it is just a paragraph.
      const list = lastList(stack)
      if (list) {
        stack.length = stack.lastIndexOf(list) + 1
        push({ tag: 'li', children: [] })
      } else {
        push({ tag: 'p', children: [] })
      }
      continue
    }

    // Block element (p, h2, h3, ul, ol, blockquote): a text block cannot hold
    // it, so close any open text block first.
    popTo((el) => TEXT_BLOCKS.has(el.tag))
    // ul/ol/blockquote/p directly inside another p-like inline host also close it.
    const t = top()
    if (t && INLINE.has(t.tag)) popTo((el) => !INLINE.has(el.tag))
    if ((tag === 'ul' || tag === 'ol') && top() && (top()!.tag === 'ul' || top()!.tag === 'ol')) {
      // A list directly inside a list: nest it in the previous item.
      const prev = top()!.children[top()!.children.length - 1]
      if (prev && prev.tag === 'li') stack.push(prev)
      else push({ tag: 'li', children: [] })
    }
    push({ tag, children: [] })
  }

  return prune(root.children)
}

function lastList(stack: ElementNode[]): ElementNode | null {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].tag === 'ul' || stack[k].tag === 'ol') return stack[k]
  }
  return null
}

const BLOCKS = new Set<Tag>(['p', 'h2', 'h3', 'ul', 'ol', 'blockquote'])

/** Drop inline elements left empty (e.g. `<strong></strong>`) and layout
 *  whitespace around the blocks inside a list item. */
function prune(nodes: Node[]): Node[] {
  const out: Node[] = []
  for (const node of nodes) {
    if (node.tag === '#text' || node.tag === 'br' || node.tag === 'img') {
      out.push(node)
      continue
    }
    node.children = prune(node.children)
    if (node.tag === 'li' && node.children.some((c) => BLOCKS.has(c.tag as Tag))) {
      node.children = node.children.filter((c) => c.tag !== '#text' || c.text.trim())
    }
    if (INLINE.has(node.tag) && node.children.length === 0) continue
    out.push(node)
  }
  return out
}

// ------------------------------------------------------------
// Serialising: sanitised HTML
// ------------------------------------------------------------
function serialize(nodes: Node[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.tag === '#text') out += escapeText(node.text)
    else if (node.tag === 'br') out += '<br>'
    else if (node.tag === 'img') {
      const size = `${node.width ? ` width="${node.width}"` : ''}${node.height ? ` height="${node.height}"` : ''}`
      out += `<img src="${escapeAttr(node.src)}" alt="${escapeAttr(node.alt)}"${size}>`
    } else if (node.tag === 'a') {
      out += `<a href="${escapeAttr(node.href ?? '')}" target="_blank" rel="noopener noreferrer nofollow">${serialize(node.children)}</a>`
    } else out += `<${node.tag}>${serialize(node.children)}</${node.tag}>`
  }
  return out
}

/**
 * Reduce any HTML to the tags an article may use: p, br, strong, em, u, s,
 * h2, h3, ul, ol, li, blockquote, a (http, https, mailto and tel links only)
 * and, only when `images` says where this account's files live, `img` (see
 * `KbImagePolicy`: the src must be the account's own public chat-media file;
 * only `src`, a text `alt` and numeric `width` / `height` survive).
 * Everything else — scripts, styles, event handlers, every other attribute,
 * `javascript:` links, data: images — is removed; malformed markup comes out
 * well formed. Without `images` every image is dropped. Idempotent.
 */
export function sanitizeKbHtml(
  html: string | null | undefined,
  options?: {
    images?: KbImagePolicy | null
    /** Keep only these image URLs (of those the policy accepts). */
    onlyImageUrls?: ReadonlySet<string>
  },
): string {
  if (!html) return ''
  return serialize(parse(html, imageRuleFor(options?.images, options?.onlyImageUrls)))
}

export interface KbImageRef {
  src: string
  alt: string
}

/**
 * The images of an article's HTML in document order. With `images` the list
 * holds only the images the sanitiser would keep. Without it every `<img>` is
 * listed with its src as written: use that only to match against URLs you
 * already trust (the editor does, to find its own uploads), never to decide
 * what is safe to show.
 */
export function listKbImages(
  html: string | null | undefined,
  options?: { images?: KbImagePolicy | null },
): KbImageRef[] {
  if (!html) return []
  const rule = options && 'images' in options ? imageRuleFor(options.images) : READ_ONLY_IMAGES
  const out: KbImageRef[] = []
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.tag === 'img') out.push({ src: node.src, alt: node.alt })
      else if (node.tag !== '#text' && node.tag !== 'br') walk(node.children)
    }
  }
  walk(parse(html, rule))
  return out
}

// ------------------------------------------------------------
// Rendering to text
// ------------------------------------------------------------
export type KbTextChannel = 'plain' | 'whatsapp'

interface Style {
  bold: string
  italic: string
  strike: string
  bullet: string
  quote: string
  /** Show an image as "[image: caption]" (its caption / alt text, and nothing
   *  for an image without one). false = images are left out entirely: chat
   *  messages carry them as separate media messages, in order. */
  images: boolean
}
const PLAIN_STYLE: Style = { bold: '', italic: '', strike: '', bullet: '- ', quote: '', images: true }
/** Plain text for a chat message or an email's text fallback: no images. */
const CHANNEL_PLAIN_STYLE: Style = { ...PLAIN_STYLE, images: false }
const WHATSAPP_STYLE: Style = { bold: '*', italic: '_', strike: '~', bullet: '• ', quote: '> ', images: false }

/** Wrap in a marker, keeping any edge whitespace outside it (a marker that
 *  touches a space does not format in WhatsApp). */
function wrap(text: string, marker: string): string {
  if (!marker) return text
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)
  if (!m || !m[2]) return text
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`
}

function collapse(s: string): string {
  return s.replace(/\u00A0/g, ' ').replace(/[ \t\r\n]+/g, ' ')
}

function stripScheme(u: string): string {
  return u.replace(/^(https?:\/\/|mailto:|tel:)/i, '').replace(/\/$/, '')
}

function renderInline(nodes: Node[], style: Style): string {
  let out = ''
  for (const node of nodes) {
    if (node.tag === '#text') out += collapse(node.text)
    else if (node.tag === 'br') out += '\n'
    else if (node.tag === 'img') {
      if (style.images && node.alt) out += `[image: ${node.alt}]`
    } else if (node.tag === 'strong') out += wrap(renderInline(node.children, style), style.bold)
    else if (node.tag === 'em') out += wrap(renderInline(node.children, style), style.italic)
    else if (node.tag === 's') out += wrap(renderInline(node.children, style), style.strike)
    else if (node.tag === 'u') out += renderInline(node.children, style)
    else if (node.tag === 'a') {
      const label = renderInline(node.children, style)
      const href = node.href ?? ''
      const bare = label.replace(/[*_~]/g, '').trim()
      if (!bare || stripScheme(bare).toLowerCase() === stripScheme(href).toLowerCase()) {
        out += bare ? label : href
      } else {
        out += `${label} (${href.replace(/^mailto:|^tel:/i, '')})`
      }
    } else {
      // A block met while reading inline content (tolerated): read through it.
      out += renderInline(node.children, style)
    }
  }
  return out
}

function tidyLine(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim()
}

function renderList(node: ElementNode, style: Style, depth: number): string {
  const lines: string[] = []
  let index = 1
  const indent = '  '.repeat(depth)
  for (const li of node.children) {
    if (li.tag !== 'li') continue
    const inline: string[] = []
    const nested: string[] = []
    let run: Node[] = []
    const flushRun = () => {
      if (run.length) inline.push(tidyLine(renderInline(run, style)))
      run = []
    }
    for (const c of li.children) {
      if (c.tag === 'ul' || c.tag === 'ol') {
        flushRun()
        nested.push(renderList(c, style, depth + 1))
      } else if (c.tag === 'p' || c.tag === 'h2' || c.tag === 'h3') {
        flushRun()
        inline.push(tidyLine(renderInline(c.children, style)))
      } else if (c.tag === 'blockquote') {
        flushRun()
        inline.push(tidyLine(renderInline(flattenInline(c), style)))
      } else run.push(c)
    }
    flushRun()
    const marker = node.tag === 'ol' ? `${index}. ` : style.bullet
    index += 1
    const text = inline.filter(Boolean).join(' ').replace(/\n/g, ` `).trim()
    lines.push(`${indent}${marker}${text}`.trimEnd())
    for (const n of nested) if (n) lines.push(n)
  }
  return lines.join('\n')
}

function flattenInline(node: ElementNode): Node[] {
  const out: Node[] = []
  node.children.forEach((c, i) => {
    if (i > 0) out.push({ tag: '#text', text: ' ' })
    if (c.tag === 'p' || c.tag === 'h2' || c.tag === 'h3' || c.tag === 'blockquote') out.push(...flattenInline(c))
    else out.push(c)
  })
  return out
}

function renderBlocks(nodes: Node[], style: Style): string[] {
  const blocks: string[] = []
  let run: Node[] = []
  const flushRun = () => {
    const t = tidyLine(renderInline(run, style))
    if (t) blocks.push(t)
    run = []
  }
  for (const node of nodes) {
    if (node.tag === 'p') {
      flushRun()
      const t = tidyLine(renderInline(node.children, style))
      if (t) blocks.push(t)
    } else if (node.tag === 'h2' || node.tag === 'h3') {
      flushRun()
      const t = tidyLine(renderInline(node.children, style))
      // Headings stand out as bold in WhatsApp; elsewhere they are a line.
      if (t) blocks.push(wrap(t, style.bold))
    } else if (node.tag === 'ul' || node.tag === 'ol') {
      flushRun()
      const t = renderList(node, style, 0)
      if (t) blocks.push(t)
    } else if (node.tag === 'blockquote') {
      flushRun()
      const inner = renderBlocks(node.children, { ...style, quote: '' }).join('\n\n')
      if (inner) {
        blocks.push(
          inner
            .split('\n')
            .map((l) => (l ? `${style.quote}${l}` : style.quote.trimEnd()))
            .join('\n'),
        )
      }
    } else run.push(node)
  }
  flushRun()
  return blocks
}

function renderTree(html: string, style: Style): string {
  // Images are only read for their caption here (and only when the style shows
  // them): this tree is never turned back into HTML.
  return renderBlocks(parse(html, style.images ? READ_ONLY_IMAGES : null), style).join('\n\n')
}

/**
 * The plain text of an article's rich body — what search indexes and the AI
 * reads. Paragraphs are separated by a blank line, list items start with
 * "- " (numbered lists keep their numbers), headings are lines of their own,
 * links read "text (url)", an image with a caption reads "[image: caption]"
 * (one without is left out) and entities are decoded.
 */
export function kbHtmlToPlainText(html: string | null | undefined): string {
  if (!html) return ''
  return renderTree(html, PLAIN_STYLE)
}

/**
 * The text to put in a chat message for a channel.
 *
 *  - WhatsApp: *bold*, _italic_, ~strike~, "• " bullets, headings in bold
 *  - Messenger, Instagram, the web widget: plain text (they do not format)
 *  - email / Gmail: plain text too — the rich version goes in `contentHtml`,
 *    this is its plain-text fallback
 *
 * Images are left out of all of them: chat channels send each image as its own
 * media message after the text, and an email keeps them inline in its HTML.
 *
 * An older article with no rich body (`html` null) is returned as its plain
 * text unchanged.
 */
export function kbHtmlToChannelText(
  html: string | null | undefined,
  plain: string,
  channel: ChannelType,
): string {
  if (!html) return plain
  return renderTree(html, channel === 'whatsapp' ? WHATSAPP_STYLE : CHANNEL_PLAIN_STYLE)
}

/**
 * Split long rich text into pieces of at most about `maxChars` of plain text,
 * cutting only between top-level blocks (paragraphs, lists ...), never inside
 * one. A single block bigger than the limit stays whole in a piece of its own;
 * the caller decides what to do with it. Used to turn a long imported document
 * into several articles.
 */
export function splitKbHtml(html: string | null | undefined, maxChars: number): string[] {
  if (!html) return []
  const groups: Node[][] = []
  let current: Node[] = []
  let length = 0
  for (const node of parse(html)) {
    const size = renderBlocks([node], PLAIN_STYLE).join('\n\n').length + 2
    if (current.length > 0 && length + size > maxChars) {
      groups.push(current)
      current = []
      length = 0
    }
    current.push(node)
    length += size
  }
  if (current.length > 0) groups.push(current)
  return groups.map((g) => serialize(g))
}

// ------------------------------------------------------------
// Plain text -> HTML (older articles open in the editor as paragraphs)
// ------------------------------------------------------------
const BULLET_LINE = /^\s*(?:[-*•]\s+)(.*\S.*)$/
const NUMBER_LINE = /^\s*\d{1,3}[.)]\s+(.*\S.*)$/

/**
 * Turn plain text into editor HTML: blank lines separate paragraphs, single
 * line breaks stay as line breaks, and runs of "- " / "• " / "1. " lines
 * become lists. Everything is escaped.
 */
export function plainTextToKbHtml(text: string | null | undefined): string {
  if (!text || !text.trim()) return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let out = ''
  let para: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null

  const flushPara = () => {
    if (para.length) out += `<p>${para.map(escapeText).join('<br>')}</p>`
    para = []
  }
  const flushList = () => {
    if (list) {
      out += `<${list.kind}>${list.items.map((i) => `<li><p>${escapeText(i)}</p></li>`).join('')}</${list.kind}>`
    }
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    const bullet = BULLET_LINE.exec(line)
    const numbered = bullet ? null : NUMBER_LINE.exec(line)
    const item = bullet ?? numbered
    if (item) {
      flushPara()
      const kind = bullet ? 'ul' : 'ol'
      if (list && list.kind !== kind) flushList()
      if (!list) list = { kind, items: [] }
      list.items.push(item[1].trim())
    } else {
      flushList()
      para.push(line.trim())
    }
  }
  flushPara()
  flushList()
  return out
}
