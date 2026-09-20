import { describe, it, expect } from 'vitest'
import {
  kbHtmlToChannelText,
  kbHtmlToPlainText,
  kbImageUrlForPath,
  kbImageUrlPrefix,
  listKbImages,
  safeImageSrc,
  sanitizeKbHtml,
  splitKbHtml,
  type KbImagePolicy,
} from './knowledge-format'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const BASE = 'https://abc.supabase.co'
const POLICY: KbImagePolicy = { accountId: ACCOUNT, publicBaseUrl: BASE }
const PREFIX = `${BASE}/storage/v1/object/public/chat-media/account-${ACCOUNT}/`
const OK = `${PREFIX}kb/1700000000000-pasted-image.png`

const clean = (html: string) => sanitizeKbHtml(html, { images: POLICY })

describe('kbImageUrlPrefix / kbImageUrlForPath', () => {
  it('is the account folder of the chat-media bucket on the project host', () => {
    expect(kbImageUrlPrefix(POLICY)).toBe(PREFIX)
  })
  it('accepts a local development server over http, but no other plain http host', () => {
    expect(kbImageUrlPrefix({ accountId: ACCOUNT, publicBaseUrl: 'http://127.0.0.1:54321' })).toContain('http://127.0.0.1:54321/storage/')
    expect(kbImageUrlPrefix({ accountId: ACCOUNT, publicBaseUrl: 'http://localhost:54321' })).not.toBeNull()
    expect(kbImageUrlPrefix({ accountId: ACCOUNT, publicBaseUrl: 'http://abc.supabase.co' })).toBeNull()
  })
  it('refuses a bad account id, a bad base and base URLs with credentials', () => {
    expect(kbImageUrlPrefix({ accountId: 'not-a-uuid', publicBaseUrl: BASE })).toBeNull()
    expect(kbImageUrlPrefix({ accountId: `${ACCOUNT}/../x`, publicBaseUrl: BASE })).toBeNull()
    expect(kbImageUrlPrefix({ accountId: ACCOUNT, publicBaseUrl: 'not a url' })).toBeNull()
    expect(kbImageUrlPrefix({ accountId: ACCOUNT, publicBaseUrl: 'https://u:p@abc.supabase.co' })).toBeNull()
    expect(kbImageUrlPrefix(null)).toBeNull()
  })
  it('turns an own object path into its public URL and refuses anything else', () => {
    expect(kbImageUrlForPath(POLICY, `account-${ACCOUNT}/kb/a.png`)).toBe(`${PREFIX}kb/a.png`)
    expect(kbImageUrlForPath(POLICY, `account-${OTHER}/kb/a.png`)).toBeNull()
    expect(kbImageUrlForPath(POLICY, `account-${ACCOUNT}/../account-${OTHER}/a.png`)).toBeNull()
    expect(kbImageUrlForPath(POLICY, `account-${ACCOUNT}/kb/a b.png`)).toBeNull()
    expect(kbImageUrlForPath(POLICY, `account-${ACCOUNT}/`)).toBeNull()
  })
})

describe('sanitizeKbHtml with images', () => {
  it('keeps an image of this account and writes only src and alt', () => {
    expect(clean(`<p>Step 1<img src="${OK}" alt="Open Settings"></p>`)).toBe(
      `<p>Step 1<img src="${OK}" alt="Open Settings"></p>`,
    )
  })

  it('always writes an alt (empty when there is none)', () => {
    expect(clean(`<p><img src="${OK}"></p>`)).toBe(`<p><img src="${OK}" alt=""></p>`)
  })

  it('puts a top-level image in a paragraph and is idempotent', () => {
    const once = clean(`<img src="${OK}" alt="x"><p>after</p>`)
    expect(once).toBe(`<p><img src="${OK}" alt="x"></p><p>after</p>`)
    expect(clean(once)).toBe(once)
  })

  it('keeps an image inside a list item and inside a link', () => {
    expect(clean(`<ul><li><img src="${OK}" alt="a"></li></ul>`)).toBe(`<ul><li><img src="${OK}" alt="a"></li></ul>`)
    expect(clean(`<p><a href="https://x.com"><img src="${OK}" alt="a"></a></p>`)).toContain(`<img src="${OK}" alt="a">`)
  })

  it('drops every other attribute (class, style, event handlers, srcset, loading ...)', () => {
    const out = clean(
      `<img src="${OK}" alt="a" class="big" style="position:fixed" onerror="alert(1)" onload="x()" srcset="https://evil.test/a.png 2x" loading="lazy" data-x="1" id="i">`,
    )
    expect(out).toBe(`<p><img src="${OK}" alt="a"></p>`)
    expect(out).not.toMatch(/onerror|onload|style|class|srcset|loading|data-|id=/)
  })

  it('keeps numeric width and height and drops anything else in them', () => {
    expect(clean(`<img src="${OK}" alt="" width="640" height="480">`)).toContain('width="640" height="480"')
    expect(clean(`<img src="${OK}" alt="" width="100%" height="auto">`)).not.toMatch(/width|height/)
    expect(clean(`<img src="${OK}" alt="" width="0" height="99999999">`)).not.toMatch(/width|height/)
    expect(clean(`<img src="${OK}" alt="" width="1e3">`)).not.toMatch(/width/)
  })

  it('escapes an alt that tries to break out of the attribute', () => {
    const out = clean(`<img src="${OK}" alt='"><script>alert(1)</script><img src=x onerror=alert(1) a="'>`)
    expect(out).not.toContain('<script')
    // the whole thing stays inside one attribute value: with the quoted values
    // blanked out there is no handler, script or second tag left
    const shape = out.replace(/"[^"]*"/g, '""')
    expect(shape).toBe('<p><img src="" alt=""></p>')
    expect(out.match(/<img /g)).toHaveLength(1)
  })

  it('decodes entities in alt as text and re-escapes them', () => {
    expect(clean(`<img src="${OK}" alt="Tom &amp; Jerry &lt;3">`)).toContain('alt="Tom &amp; Jerry &lt;3"')
  })

  it('limits and tidies a long, multi-line alt', () => {
    const out = clean(`<img src="${OK}" alt="${'a'.repeat(3000)}">`)
    expect(out.match(/alt="(a+)"/)![1].length).toBe(1024)
    expect(clean(`<img src="${OK}" alt="one&#10;two   three">`)).toContain('alt="one two three"')
  })

  it('removes every image when no policy is given', () => {
    expect(sanitizeKbHtml(`<p>Hi<img src="${OK}" alt="x"></p>`)).toBe('<p>Hi</p>')
    expect(sanitizeKbHtml(`<p>Hi<img src="${OK}" alt="x"></p>`, { images: null })).toBe('<p>Hi</p>')
    // a policy that cannot be used accepts nothing
    expect(sanitizeKbHtml(`<img src="${OK}">`, { images: { accountId: 'bad', publicBaseUrl: BASE } })).toBe('')
  })

  it('can be limited to a list of URLs', () => {
    const other = `${PREFIX}kb/other.png`
    const out = sanitizeKbHtml(`<p><img src="${OK}" alt="a"><img src="${other}" alt="b"></p>`, {
      images: POLICY,
      onlyImageUrls: new Set([other]),
    })
    expect(out).toBe(`<p><img src="${other}" alt="b"></p>`)
  })
})

describe('sanitizeKbHtml — image XSS and abuse attempts', () => {
  const dropped = (src: string) => clean(`<p>x<img src="${src}" alt="a"></p>`)

  it.each([
    ['javascript: URL', 'javascript:alert(1)'],
    ['javascript: URL, mixed case and tab', 'JaVa\tScRiPt:alert(1)'],
    ['javascript: URL with an entity', 'java&#115;cript:alert(1)'],
    ['data: SVG', 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+'],
    ['data: PNG', 'data:image/png;base64,iVBORw0KGgo='],
    ['vbscript: URL', 'vbscript:msgbox(1)'],
    ['blob: URL', 'blob:https://app.example/1234'],
    ['file: URL', 'file:///C:/Users/x/a.png'],
    ['relative path', '/storage/v1/object/public/chat-media/a.png'],
    ['protocol-relative URL', `//abc.supabase.co/storage/v1/object/public/chat-media/account-${ACCOUNT}/a.png`],
    ['another host', `https://evil.example/storage/v1/object/public/chat-media/account-${ACCOUNT}/a.png`],
    ['a look-alike host (suffix)', `https://abc.supabase.co.evil.example/storage/v1/object/public/chat-media/account-${ACCOUNT}/a.png`],
    ['a look-alike host (userinfo)', `https://abc.supabase.co@evil.example/storage/v1/object/public/chat-media/account-${ACCOUNT}/a.png`],
    ['plain http on the project host', `http://abc.supabase.co/storage/v1/object/public/chat-media/account-${ACCOUNT}/a.png`],
    ['another account', `${BASE}/storage/v1/object/public/chat-media/account-${OTHER}/kb/a.png`],
    ['an account folder prefix that only starts the same', `${BASE}/storage/v1/object/public/chat-media/account-${ACCOUNT}x/a.png`],
    ['another bucket', `${BASE}/storage/v1/object/public/flow-media/account-${ACCOUNT}/kb/a.png`],
    ['a private (authenticated) object URL', `${BASE}/storage/v1/object/authenticated/chat-media/account-${ACCOUNT}/kb/a.png`],
    ['a signed URL (query string)', `${PREFIX}kb/a.png?token=abc`],
    ['a cache-busting query string', `${PREFIX}kb/a.png?v=2`],
    ['a fragment', `${PREFIX}kb/a.png#x`],
    ['path traversal', `${PREFIX}../account-${OTHER}/kb/a.png`],
    ['path traversal in the middle', `${PREFIX}kb/../../account-${OTHER}/a.png`],
    ['an encoded traversal', `${PREFIX}%2e%2e/account-${OTHER}/a.png`],
    ['an encoded slash', `${PREFIX}kb%2fa.png`],
    ['a backslash', `${PREFIX}kb\\..\\a.png`],
    ['a double slash', `${PREFIX}kb//a.png`],
    ['a dot-leading segment', `${PREFIX}.hidden/a.png`],
    ['a space', `${PREFIX}kb/a b.png`],
    ['a newline', `${PREFIX}kb/a\n.png`],
    ['an empty path', PREFIX],
    ['nothing', ''],
  ])('drops an image whose src is %s', (_name, src) => {
    expect(dropped(src)).toBe('<p>x</p>')
  })

  it('drops leading or trailing whitespace instead of trimming it', () => {
    expect(dropped(` ${OK}`)).toBe('<p>x</p>')
    expect(dropped(`${OK} `)).toBe('<p>x</p>')
  })

  it('drops an image with no src, with an unquoted hostile src, and other image-like tags', () => {
    expect(clean('<img alt="a">')).toBe('')
    expect(clean('<img src=javascript:alert(1)>')).toBe('')
    expect(clean(`<image src="${OK}">`)).toBe('')
    expect(clean(`<picture><source srcset="${OK}"><img src="https://evil.example/a.png"></picture>`)).toBe('')
    expect(clean(`<svg onload="alert(1)"><image href="${OK}"/></svg>`)).toBe('')
    expect(clean(`<video src="${OK}"></video><embed src="${OK}"><object data="${OK}"></object>`)).toBe('')
  })

  it('does not let an image smuggle markup into another tag or attribute', () => {
    const out = clean(`<img src="${OK}" alt="a" src="https://evil.example/x.png">`)
    expect(out).toBe(`<p><img src="${OK}" alt="a"></p>`)
    expect(clean(`<img/src="${OK}"/alt=hi>`)).toBe(`<p><img src="${OK}" alt="hi"></p>`)
  })

  it('never emits an image whose src is not exactly one of the account files, whatever the input', () => {
    const nasty = [
      `<img src="${OK}\u0000" alt="x">`,
      `<img src="${OK}&#0;" alt="x">`,
      `<img src="${OK}&#x0a;" alt="x">`,
      `<img src="${OK}&quot; onerror=&quot;alert(1)" alt="x">`,
      `<img src=${OK}/../../x.png alt=x>`,
      `<IMG SRC="${OK.replace('https', 'HTTPS')}">`,
    ]
    for (const html of nasty) {
      const out = clean(html)
      for (const m of out.matchAll(/<img src="([^"]*)"/g)) {
        expect(m[1]).toBe(safeImageSrc(m[1], POLICY))
      }
      expect(out).not.toMatch(/onerror|\.\.\//i)
    }
  })
})

describe('safeImageSrc', () => {
  it('accepts an own file and refuses the rest', () => {
    expect(safeImageSrc(OK, POLICY)).toBe(OK)
    expect(safeImageSrc(`${OK.replace(/&/g, '&amp;')}`, POLICY)).toBe(OK)
    expect(safeImageSrc(undefined, POLICY)).toBeNull()
    expect(safeImageSrc(OK, null)).toBeNull()
    expect(safeImageSrc(`${PREFIX}kb/${'a'.repeat(400)}.png`, POLICY)).toBeNull()
  })
})

describe('listKbImages', () => {
  it('lists the images a policy keeps, in document order', () => {
    const b = `${PREFIX}kb/b.png`
    const html = `<p>1<img src="${OK}" alt="first"></p><p><img src="https://evil.example/x.png" alt="no"></p><p><img src="${b}" alt="second"></p>`
    expect(listKbImages(html, { images: POLICY })).toEqual([
      { src: OK, alt: 'first' },
      { src: b, alt: 'second' },
    ])
  })
  it('lists every image as written when no policy is given (for matching your own uploads)', () => {
    expect(listKbImages(`<p><img src="blob:x" alt="a"></p>`)).toEqual([{ src: 'blob:x', alt: 'a' }])
  })
  it('lists nothing for a policy of null and for empty input', () => {
    expect(listKbImages(`<img src="${OK}">`, { images: null })).toEqual([])
    expect(listKbImages('')).toEqual([])
    expect(listKbImages(null)).toEqual([])
  })
})

describe('text derived from an article with images', () => {
  const html = `<p>Open the menu.</p><p><img src="${OK}" alt="The Settings menu"></p><p><img src="${OK}" alt=""></p><p>Then save.</p>`

  it('reads a captioned image as [image: caption] and leaves out one without', () => {
    expect(kbHtmlToPlainText(html)).toBe('Open the menu.\n\n[image: The Settings menu]\n\nThen save.')
  })

  it('reads an image inside a sentence and in a list', () => {
    expect(kbHtmlToPlainText(`<p>Click <img src="${OK}" alt="the gear"> now</p>`)).toBe('Click [image: the gear] now')
    expect(kbHtmlToPlainText(`<ul><li>Pick <img src="${OK}" alt="one"></li></ul>`)).toBe('- Pick [image: one]')
  })

  it('does not read an image that has no caption, even alone', () => {
    expect(kbHtmlToPlainText(`<p><img src="${OK}" alt=""></p>`)).toBe('')
  })

  it('leaves images out of chat text for every channel', () => {
    for (const channel of ['whatsapp', 'messenger', 'instagram', 'web_widget', 'email', 'gmail'] as const) {
      const text = kbHtmlToChannelText(html, '', channel)
      expect(text).toBe('Open the menu.\n\nThen save.')
      expect(text).not.toContain('image')
    }
  })

  it('does not let a foreign src into the text either (only the caption is ever read)', () => {
    expect(kbHtmlToPlainText(`<p><img src="javascript:alert(1)" alt="cap"></p>`)).toBe('[image: cap]')
    expect(kbHtmlToPlainText(`<p><img src="javascript:alert(1)" alt="cap"></p>`)).not.toContain('javascript')
  })

  it('leaves images out when splitting a long article', () => {
    const pieces = splitKbHtml(`<p>${'a'.repeat(50)}</p><p><img src="${OK}" alt="x"></p><p>${'b'.repeat(50)}</p>`, 60)
    expect(pieces.join('')).not.toContain('<img')
  })
})
