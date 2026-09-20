import { describe, it, expect } from 'vitest'
import {
  decodeEntities,
  kbHtmlToChannelText,
  kbHtmlToPlainText,
  plainTextToKbHtml,
  sanitizeKbHtml,
  splitKbHtml,
} from './knowledge-format'

const NBSP = String.fromCharCode(160)
const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer nofollow"'

describe('sanitizeKbHtml — keeps what an article may use', () => {
  it('keeps the allowed formatting tags', () => {
    const html =
      '<h2>Title</h2><p>A <strong>bold</strong>, <em>italic</em>, <u>underlined</u> and <s>struck</s> line<br>second</p>' +
      '<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li>a</li></ol><blockquote><p>quoted</p></blockquote><h3>Sub</h3>'
    expect(sanitizeKbHtml(html)).toBe(html)
  })

  it('is idempotent', () => {
    const messy = '<div>Hi <b>there</b><script>alert(1)</script><a href="https://x.com/?a=1&b=2" onclick="x()">go</a></div>'
    const once = sanitizeKbHtml(messy)
    expect(sanitizeKbHtml(once)).toBe(once)
  })

  it('returns an empty string for empty input', () => {
    expect(sanitizeKbHtml('')).toBe('')
    expect(sanitizeKbHtml(null)).toBe('')
    expect(sanitizeKbHtml(undefined)).toBe('')
  })

  it('renames b / i / strike / h1 / h4 and turns divs into paragraphs', () => {
    expect(sanitizeKbHtml('<h1>T</h1><div>x <b>b</b> <i>i</i> <del>d</del></div><h4>s</h4>')).toBe(
      '<h2>T</h2><p>x <strong>b</strong> <em>i</em> <s>d</s></p><h3>s</h3>',
    )
  })

  it('wraps loose text in a paragraph', () => {
    expect(sanitizeKbHtml('just text')).toBe('<p>just text</p>')
    expect(sanitizeKbHtml('<ul>stray</ul>')).toBe('<ul><li>stray</li></ul>')
  })

  it('drops layout whitespace between blocks', () => {
    expect(sanitizeKbHtml('<p>a</p>\n\n  <p>b</p>\n')).toBe('<p>a</p><p>b</p>')
    expect(sanitizeKbHtml('<ul>\n <li>\n <p>a</p>\n </li>\n</ul>')).toBe('<ul><li><p>a</p></li></ul>')
  })

  it('nests lists inside list items', () => {
    expect(sanitizeKbHtml('<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>')).toBe(
      '<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>',
    )
    expect(sanitizeKbHtml('<ul><li>a<ul><li>b</li></ul></li></ul>')).toBe('<ul><li>a<ul><li>b</li></ul></li></ul>')
  })

  it('turns an <li> outside any list into a paragraph', () => {
    expect(sanitizeKbHtml('<li>lonely</li>')).toBe('<p>lonely</p>')
  })

  it('does not nest blocks inside a paragraph', () => {
    expect(sanitizeKbHtml('<p>a<ul><li>b</li></ul>c</p>')).toBe('<p>a</p><ul><li>b</li></ul><p>c</p>')
    expect(sanitizeKbHtml('<p><strong>a<h2>h</h2></strong></p>')).toBe('<p><strong>a</strong></p><h2>h</h2>')
  })

  it('removes empty inline elements', () => {
    expect(sanitizeKbHtml('<p>a<strong></strong>b<a href="https://x.com"></a></p>')).toBe('<p>ab</p>')
  })
})

describe('sanitizeKbHtml — hostile input', () => {
  it('removes script, style and other dangerous elements with their content', () => {
    expect(sanitizeKbHtml('<p>a</p><script>alert("x")</script><p>b</p>')).toBe('<p>a</p><p>b</p>')
    expect(sanitizeKbHtml('<style>body{display:none}</style><p>a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<p>a</p><iframe src="https://evil.com">fallback</iframe>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<object data="x"><param name=a></object><embed src="x"><p>a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<svg onload="alert(1)"><script>x</script></svg><p>ok</p>')).toBe('<p>ok</p>')
    expect(sanitizeKbHtml('<math><mi>x</mi></math><noscript><img src=x></noscript><p>ok</p>')).toBe('<p>ok</p>')
  })

  it('is not fooled by case or spacing in script tags', () => {
    expect(sanitizeKbHtml('<ScRiPt>alert(1)</sCrIpT ><p>a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<script\n>alert(1)</script\n><p>a</p>')).toBe('<p>a</p>')
  })

  it('drops an unterminated script and everything after it', () => {
    expect(sanitizeKbHtml('<p>a</p><script>alert(1)')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<p>a</p><script src=//evil.com/x.js')).toBe('<p>a</p>')
  })

  it('strips event handlers and every attribute except a safe href', () => {
    expect(sanitizeKbHtml('<p onclick="x()" style="color:red" class="c" id="i">a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<img src=x onerror=alert(1)><p>a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<a href="https://x.com" onmouseover="alert(1)" style="x">l</a>')).toBe(
      `<p><a href="https://x.com" ${LINK_ATTRS}>l</a></p>`,
    )
    expect(sanitizeKbHtml('<strong onclick="1">b</strong>')).toBe('<p><strong>b</strong></p>')
  })

  it('allows only http, https, mailto and tel links', () => {
    expect(sanitizeKbHtml('<a href="http://a.com">x</a>')).toContain('href="http://a.com"')
    expect(sanitizeKbHtml('<a href="HTTPS://a.com">x</a>')).toContain('href="HTTPS://a.com"')
    expect(sanitizeKbHtml('<a href="mailto:hi@a.com">x</a>')).toContain('href="mailto:hi@a.com"')
    expect(sanitizeKbHtml('<a href="tel:+60123456789">x</a>')).toContain('href="tel:+60123456789"')
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'jav&#x61;script:alert(1)',
      '&#106;avascript:alert(1)',
      'javascript&colon;alert(1)',
      'javascript&Tab;:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.com',
      '/relative/path',
      'ftp://a.com',
      'file:///etc/passwd',
      '',
    ]) {
      const out = sanitizeKbHtml(`<a href="${bad}">click</a>`)
      expect(out, bad).toBe('<p>click</p>')
    }
  })

  it('handles unquoted and single-quoted hrefs', () => {
    expect(sanitizeKbHtml("<a href='https://a.com/x'>l</a>")).toContain('href="https://a.com/x"')
    expect(sanitizeKbHtml('<a href=https://a.com/x>l</a>')).toContain('href="https://a.com/x"')
    expect(sanitizeKbHtml('<a href=javascript:alert(1)>l</a>')).toBe('<p>l</p>')
  })

  it('escapes quotes and angle brackets in an href so it cannot break out', () => {
    const out = sanitizeKbHtml('<a href="https://a.com/?q=&quot;onmouseover=&quot;alert(1)">l</a>')
    expect(out).toBe(`<p><a href="https://a.com/?q=&quot;onmouseover=&quot;alert(1)" ${LINK_ATTRS}>l</a></p>`)
    expect(out).not.toMatch(/href="[^"]*"[^>]*onmouseover/)
  })

  it('percent-encodes spaces and drops control characters in an href', () => {
    expect(sanitizeKbHtml('<a href="https://a.com/a b">l</a>')).toContain('href="https://a.com/a%20b"')
  })

  it('does not nest links', () => {
    expect(sanitizeKbHtml('<a href="https://a.com">x<a href="https://b.com">y</a></a>')).toBe(
      `<p><a href="https://a.com" ${LINK_ATTRS}>x</a><a href="https://b.com" ${LINK_ATTRS}>y</a></p>`,
    )
  })

  it('removes comments, doctype, CDATA and processing instructions', () => {
    expect(sanitizeKbHtml('<!-- <script>alert(1)</script> --><p>a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<!DOCTYPE html><?xml version="1.0"?><p>a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<![CDATA[<script>alert(1)</script>]]><p>a</p>')).not.toContain('<script')
    expect(sanitizeKbHtml('<p>a</p><!-- never closed <script>')).toBe('<p>a</p>')
  })

  it('escapes text that only looks like markup', () => {
    expect(sanitizeKbHtml('<p>1 < 2 and 3 > 2</p>')).toBe('<p>1 &lt; 2 and 3 &gt; 2</p>')
    expect(sanitizeKbHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
    expect(sanitizeKbHtml('<p>Tom &amp; Jerry &copy;</p>')).toBe('<p>Tom &amp; Jerry ©</p>')
    expect(sanitizeKbHtml('<p>a<b</p>')).not.toContain('<b')
  })

  it('never leaves a half-open tag behind', () => {
    for (const bad of ['<p>ok</p><a href="https://a.com', '<p>ok</p><img src="x', '<p>ok</p><div class="a"', '<p>ok</p></p', '<p>ok</p><']) {
      const out = sanitizeKbHtml(bad)
      expect(out.startsWith('<p>ok</p>'), bad).toBe(true)
      expect(out.replace(/<\/?(p|br|strong|em|u|s|h2|h3|ul|ol|li|blockquote)>/g, '')).not.toMatch(/[<>]/)
    }
  })

  it('survives attribute-position tricks', () => {
    expect(sanitizeKbHtml('<p/onclick=alert(1)>a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<a href="https://a.com"onclick="x()">l</a>')).not.toContain('onclick')
    expect(sanitizeKbHtml('<p title=">">a</p>')).toBe('<p>a</p>')
    expect(sanitizeKbHtml('<img """><script>alert(1)</script>">')).not.toContain('script')
  })

  it('numeric entities cannot smuggle control characters or invalid code points', () => {
    expect(sanitizeKbHtml('<p>a&#0;b&#1;c&#x110000;d&#xD800;e</p>')).toBe('<p>abcde</p>')
  })

  it('handles unknown / mismatched closing tags without breaking structure', () => {
    expect(sanitizeKbHtml('<p>a</span></div></li></ul></strong>b</p>')).toBe('<p>a</p><p>b</p>')
    expect(sanitizeKbHtml('</p></p><p>a</p>')).toBe('<p>a</p>')
  })

  it('copes with a very deep or very long input without hanging', () => {
    const deep = '<blockquote>'.repeat(200000) + 'x' + '</blockquote>'.repeat(200000)
    expect(sanitizeKbHtml(deep)).toContain('x')
    expect(kbHtmlToPlainText(deep)).toBe('x')
    const deepList = '<ul><li>'.repeat(100000) + 'y'
    expect(kbHtmlToPlainText(deepList)).toContain('y')
    const long = '<p>' + 'word '.repeat(50000) + '</p>'
    expect(sanitizeKbHtml(long).length).toBeGreaterThan(200000)
  })

  it('output contains only allow-listed tags for a battery of payloads', () => {
    const payloads = [
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '<body onload=alert(1)>',
      '<input autofocus onfocus=alert(1)>',
      '<a href="jav&#x09;ascript:alert(1)">x</a>',
      '<form action="javascript:alert(1)"><button>x</button></form>',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<link rel=stylesheet href=//evil.com/x.css>',
      '<base href="//evil.com/">',
      '<isindex action=javascript:alert(1)>',
      '<video><source onerror=alert(1)></video>',
      '<details open ontoggle=alert(1)>',
      '<marquee onstart=alert(1)>',
      '<table><tr><td onclick=alert(1)>x</td></tr></table>',
      '"><script>alert(1)</script>',
      "'><img src=x onerror=alert(1)>",
    ]
    const allowed = /^(p|br|strong|em|u|s|h2|h3|ul|ol|li|blockquote|a)$/
    for (const p of payloads) {
      const out = sanitizeKbHtml(p)
      for (const m of out.matchAll(/<\/?([a-zA-Z0-9]+)/g)) expect(m[1], p).toMatch(allowed)
      expect(out.toLowerCase(), p).not.toMatch(/on[a-z]+\s*=|javascript:/)
    }
  })
})

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeEntities('&amp; &lt; &gt; &quot; &#65; &#x42; &unknown; &nbsp;')).toBe(`& < > " A B &unknown; ${NBSP}`)
  })
})

describe('kbHtmlToPlainText', () => {
  it('separates paragraphs with a blank line', () => {
    expect(kbHtmlToPlainText('<p>One.</p><p>Two.</p>')).toBe('One.\n\nTwo.')
  })

  it('writes bullets with "- " and numbered lists with their numbers', () => {
    expect(kbHtmlToPlainText('<ul><li><p>a</p></li><li><p>b</p></li></ul>')).toBe('- a\n- b')
    expect(kbHtmlToPlainText('<ol><li>first</li><li>second</li><li>third</li></ol>')).toBe('1. first\n2. second\n3. third')
  })

  it('indents nested lists', () => {
    expect(kbHtmlToPlainText('<ul><li><p>a</p><ul><li><p>b</p><ol><li>c</li></ol></li></ul></li><li>d</li></ul>')).toBe(
      '- a\n  - b\n    1. c\n- d',
    )
  })

  it('puts headings on their own lines', () => {
    expect(kbHtmlToPlainText('<h2>Refunds</h2><p>Within 14 days.</p><h3>Note</h3><p>x</p>')).toBe(
      'Refunds\n\nWithin 14 days.\n\nNote\n\nx',
    )
  })

  it('writes links as "text (url)" and collapses a link that is its own text', () => {
    expect(kbHtmlToPlainText('<p>See <a href="https://x.com/faq">our FAQ</a>.</p>')).toBe('See our FAQ (https://x.com/faq).')
    expect(kbHtmlToPlainText('<p><a href="https://x.com">https://x.com</a></p>')).toBe('https://x.com')
    expect(kbHtmlToPlainText('<p><a href="https://www.x.com/">www.x.com</a></p>')).toBe('www.x.com')
    expect(kbHtmlToPlainText('<p>Mail <a href="mailto:hi@x.com">us</a></p>')).toBe('Mail us (hi@x.com)')
    expect(kbHtmlToPlainText('<p><a href="mailto:hi@x.com">hi@x.com</a></p>')).toBe('hi@x.com')
  })

  it('turns <br> into a line break and decodes entities', () => {
    expect(kbHtmlToPlainText('<p>Line 1<br>Line 2 &amp; more &lt;b&gt;</p>')).toBe('Line 1\nLine 2 & more <b>')
  })

  it('collapses whitespace and treats non-breaking spaces as spaces', () => {
    expect(kbHtmlToPlainText(`<p>a   b\n c${NBSP}d</p>`)).toBe('a b c d')
  })

  it('ignores empty paragraphs and drops formatting', () => {
    expect(kbHtmlToPlainText('<p>a</p><p></p><p><strong>b</strong> <em>c</em></p>')).toBe('a\n\nb c')
  })

  it('drops scripts and other hostile content from the text too', () => {
    expect(kbHtmlToPlainText('<p>safe</p><script>alert(1)</script><style>x{}</style>')).toBe('safe')
  })

  it('handles empty input', () => {
    expect(kbHtmlToPlainText('')).toBe('')
    expect(kbHtmlToPlainText(null)).toBe('')
  })

  it('reads a blockquote as its paragraphs', () => {
    expect(kbHtmlToPlainText('<blockquote><p>wise</p><p>words</p></blockquote>')).toBe('wise\n\nwords')
  })
})

describe('kbHtmlToChannelText', () => {
  const html =
    '<h2>Refunds</h2><p>You get <strong>full</strong> refunds in <em>14 days</em>, <s>not 30</s>.</p>' +
    '<ul><li><p>Keep the receipt</p></li><li><p>Unused items</p></li></ul>' +
    '<p>See <a href="https://x.com/refunds">refund policy</a>.</p>'

  it('formats for WhatsApp', () => {
    expect(kbHtmlToChannelText(html, 'plain', 'whatsapp')).toBe(
      '*Refunds*\n\nYou get *full* refunds in _14 days_, ~not 30~.\n\n• Keep the receipt\n• Unused items\n\nSee refund policy (https://x.com/refunds).',
    )
  })

  it('is plain text for Messenger, Instagram and the web widget', () => {
    const expected =
      'Refunds\n\nYou get full refunds in 14 days, not 30.\n\n- Keep the receipt\n- Unused items\n\nSee refund policy (https://x.com/refunds).'
    for (const ch of ['messenger', 'instagram', 'web_widget'] as const) {
      expect(kbHtmlToChannelText(html, 'plain', ch)).toBe(expected)
    }
  })

  it('gives email its plain-text fallback', () => {
    expect(kbHtmlToChannelText(html, 'plain', 'email')).toBe(kbHtmlToChannelText(html, 'plain', 'gmail'))
    expect(kbHtmlToChannelText(html, 'plain', 'email')).not.toContain('*')
  })

  it('returns the plain text untouched for an article with no rich body', () => {
    expect(kbHtmlToChannelText(null, 'Plain *text* as written', 'whatsapp')).toBe('Plain *text* as written')
    expect(kbHtmlToChannelText('', 'Plain', 'messenger')).toBe('Plain')
  })

  it('keeps spaces outside the WhatsApp markers so bold still renders', () => {
    expect(kbHtmlToChannelText('<p>a <strong> b </strong> c</p>', '', 'whatsapp')).toBe('a  *b*  c'.replace(/ {2}/g, ' '))
  })

  it('numbers ordered lists and quotes blockquotes on WhatsApp', () => {
    expect(kbHtmlToChannelText('<ol><li>a</li><li>b</li></ol>', '', 'whatsapp')).toBe('1. a\n2. b')
    expect(kbHtmlToChannelText('<blockquote><p>q</p></blockquote>', '', 'whatsapp')).toBe('> q')
  })

  it('does not bold an empty run', () => {
    expect(kbHtmlToChannelText('<p>a<strong> </strong>b</p>', '', 'whatsapp')).toBe('a b')
  })
})

describe('plainTextToKbHtml', () => {
  it('makes paragraphs from blank lines and <br> from single line breaks', () => {
    expect(plainTextToKbHtml('One\nline two\n\nSecond')).toBe('<p>One<br>line two</p><p>Second</p>')
  })

  it('escapes markup', () => {
    expect(plainTextToKbHtml('a <script>alert(1)</script> & b')).toBe('<p>a &lt;script&gt;alert(1)&lt;/script&gt; &amp; b</p>')
  })

  it('turns runs of bullet and numbered lines into lists', () => {
    expect(plainTextToKbHtml('Intro\n- a\n- b\n\n1. x\n2) y')).toBe(
      '<p>Intro</p><ul><li><p>a</p></li><li><p>b</p></li></ul><ol><li><p>x</p></li><li><p>y</p></li></ol>',
    )
    expect(plainTextToKbHtml('• one\n• two')).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul>')
  })

  it('handles CRLF and empty input', () => {
    expect(plainTextToKbHtml('a\r\n\r\nb')).toBe('<p>a</p><p>b</p>')
    expect(plainTextToKbHtml('')).toBe('')
    expect(plainTextToKbHtml('  \n ')).toBe('')
  })

  it('round-trips simple text through HTML and back', () => {
    const text = 'Opening hours\n\nMon-Fri 9am to 6pm\nSat 9am to 1pm\n\n- Closed on public holidays\n- Call ahead'
    expect(kbHtmlToPlainText(plainTextToKbHtml(text))).toBe(text)
  })

  it('produces HTML that the sanitiser leaves alone', () => {
    const html = plainTextToKbHtml('a & b\n\n- x\n- y')
    expect(sanitizeKbHtml(html)).toBe(html)
  })
})

describe('splitKbHtml', () => {
  it('cuts between top-level blocks and never inside one', () => {
    const p = (n: number) => `<p>${String(n).repeat(40)}</p>`
    const html = [1, 2, 3, 4, 5].map(p).join('') + '<ul><li>a</li><li>b</li></ul>'
    const parts = splitKbHtml(html, 100)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(html)
    for (const part of parts) expect(sanitizeKbHtml(part)).toBe(part)
  })

  it('keeps everything in one piece when it fits', () => {
    expect(splitKbHtml('<p>a</p><p>b</p>', 1000)).toEqual(['<p>a</p><p>b</p>'])
  })

  it('leaves one oversized block whole in a piece of its own', () => {
    const big = `<ul>${'<li>' + 'x'.repeat(60) + '</li>'.repeat(1)}</ul>`
    const parts = splitKbHtml(`<p>a</p>${big}<p>b</p>`, 30)
    expect(parts).toEqual(['<p>a</p>', big, '<p>b</p>'])
  })

  it('returns nothing for empty input', () => {
    expect(splitKbHtml('', 100)).toEqual([])
    expect(splitKbHtml(null, 100)).toEqual([])
  })
})
