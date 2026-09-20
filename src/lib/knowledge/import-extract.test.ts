import { describe, it, expect } from 'vitest'
import {
  MAX_IMPORT_ARTICLES,
  MAX_IMPORT_PAIRS,
  csvToItems,
  decodeTextFile,
  detectFileFormat,
  documentHtmlToItems,
  htmlToItems,
  isProbablyBinary,
  markdownToItems,
  markdownToKbHtml,
  pairsToItems,
  pdfTextToPlain,
  plainTextToItems,
  titleFromFileName,
  unsupportedFileMessage,
} from './import-extract'
import { MAX_CONTENT_CHARS } from '@/lib/ai/knowledge-doc'

const BOM = String.fromCharCode(0xfeff)

describe('detectFileFormat', () => {
  it('goes by extension first, case-insensitively', () => {
    expect(detectFileFormat('Guide.PDF', '')).toBe('pdf')
    expect(detectFileFormat('a.docx', 'application/octet-stream')).toBe('docx')
    expect(detectFileFormat('notes.md', '')).toBe('markdown')
    expect(detectFileFormat('faq.csv', 'application/vnd.ms-excel')).toBe('csv')
    expect(detectFileFormat('readme.txt', 'text/plain')).toBe('text')
  })
  it('falls back to the MIME type', () => {
    expect(detectFileFormat('download', 'application/pdf')).toBe('pdf')
    expect(detectFileFormat('download', 'text/csv')).toBe('csv')
  })
  it('refuses what it cannot read', () => {
    expect(detectFileFormat('a.doc', 'application/msword')).toBeNull()
    expect(detectFileFormat('a.xlsx', '')).toBeNull()
    expect(detectFileFormat('a.exe', 'application/octet-stream')).toBeNull()
  })
  it('explains .doc specifically', () => {
    expect(unsupportedFileMessage('a.doc')).toContain('.docx')
    expect(unsupportedFileMessage('a.zip')).toContain('PDF, Word (.docx), text, Markdown or CSV')
  })
})

describe('titleFromFileName', () => {
  it('drops the extension and path and tidies separators', () => {
    expect(titleFromFileName('C:\\docs\\Return_policy_2026.pdf')).toBe('Return policy 2026')
    expect(titleFromFileName('/tmp/opening-hours.docx')).toBe('opening-hours')
    expect(titleFromFileName('.pdf')).toBe('Imported article')
  })
})

describe('pairsToItems', () => {
  it('makes one Q&A draft per pair and counts what it skipped', () => {
    const r = pairsToItems([
      { question: ' Do you ship? ', answer: ' Yes, worldwide. ' },
      { question: 'Empty', answer: '  ' },
      { question: '', answer: 'no question' },
      'junk',
      null,
    ])
    expect(r).toEqual({
      ok: true,
      skipped: 4,
      items: [{ title: 'Do you ship?', content: 'Yes, worldwide.', content_html: null, kind: 'qa' }],
    })
  })

  it('clips a very long question to fit the title and skips an over-long answer', () => {
    const r = pairsToItems([
      { question: 'q'.repeat(500), answer: 'a' },
      { question: 'ok', answer: 'x'.repeat(MAX_CONTENT_CHARS + 1) },
    ])
    expect(r.ok && r.items).toHaveLength(1)
    expect(r.ok && r.items[0].title.length).toBe(200)
    expect(r.ok && r.skipped).toBe(1)
  })

  it('rejects a non-list, an empty list and more than the cap', () => {
    expect(pairsToItems('x')).toMatchObject({ ok: false, status: 400 })
    expect(pairsToItems([])).toMatchObject({ ok: false, status: 400 })
    const many = Array.from({ length: MAX_IMPORT_PAIRS + 1 }, (_, i) => ({ question: `q${i}`, answer: 'a' }))
    expect(pairsToItems(many)).toMatchObject({ ok: false, status: 400 })
    expect(pairsToItems(many.slice(0, MAX_IMPORT_PAIRS)).ok).toBe(true)
  })
})

describe('markdownToKbHtml', () => {
  it('reads headings, lists, quotes and paragraphs', () => {
    const md = '# Title\n\nIntro line one\nline two\n\n## Steps\n\n1. First\n2. Second\n\n- a\n- b\n\n> quoted\n\n### Small'
    expect(markdownToKbHtml(md)).toBe(
      '<h2>Title</h2><p>Intro line one line two</p><h2>Steps</h2><ol><li>First</li><li>Second</li></ol>' +
        '<ul><li>a</li><li>b</li></ul><blockquote><p>quoted</p></blockquote><h3>Small</h3>',
    )
  })

  it('reads inline formatting and links', () => {
    const html = markdownToKbHtml('**bold** and *italic* and ~~gone~~ and [site](https://x.com/a?b=1&c=2) and `code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<s>gone</s>')
    expect(html).toContain('href="https://x.com/a?b=1&amp;c=2"')
    expect(html).toContain('and code<')
    expect(html).not.toContain('`')
  })

  it('keeps snake_case and multiplication asterisks as they are', () => {
    const html = markdownToKbHtml('use snake_case_names and 2 * 3 * 4')
    expect(html).toBe('<p>use snake_case_names and 2 * 3 * 4</p>')
  })

  it('escapes raw HTML and refuses unsafe links', () => {
    const html = markdownToKbHtml('<script>alert(1)</script> [x](javascript:alert(1)) <b onclick=x>b</b>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<b')
    expect(html).not.toContain('href')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps fenced code as plain lines and drops rules and images', () => {
    expect(markdownToKbHtml('```\nrun this\n```\n\n---\n\n![alt text](x.png)')).toBe('<p>run this</p><p>alt text</p>')
  })

  it('handles a BOM and CRLF', () => {
    expect(markdownToKbHtml(`${BOM}# A\r\n\r\nB`)).toBe('<h2>A</h2><p>B</p>')
  })
})

describe('markdownToItems', () => {
  it('uses the first heading as the title, else the file name', () => {
    const a = markdownToItems('# Refund policy\n\nWithin 14 days.', 'notes.md')
    expect(a.ok && a.items[0]).toMatchObject({ title: 'Refund policy', kind: 'article', content: 'Refund policy\n\nWithin 14 days.' })
    const b = markdownToItems('Just text.', 'opening_hours.md')
    expect(b.ok && b.items[0].title).toBe('opening hours')
  })
})

describe('htmlToItems', () => {
  it('returns one article with plain and rich text', () => {
    const r = htmlToItems('Guide', '<h2>Hi</h2><p>a <strong>b</strong></p><script>x</script>')
    expect(r).toEqual({
      ok: true,
      skipped: 0,
      items: [{ title: 'Guide', content: 'Hi\n\na b', content_html: '<h2>Hi</h2><p>a <strong>b</strong></p>', kind: 'article' }],
    })
  })

  it('splits a long document into numbered parts, each within the article limit', () => {
    const para = '<p>' + 'word '.repeat(400) + '</p>' // ~2000 chars
    const r = htmlToItems('Handbook', para.repeat(30)) // ~60,000 chars
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items.length).toBeGreaterThan(2)
      expect(r.items[0].title).toBe('Handbook')
      expect(r.items[1].title).toBe('Handbook (part 2)')
      for (const item of r.items) expect(item.content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS)
    }
  })

  it('splits one enormous block as plain text so nothing exceeds the limit', () => {
    const items = '<li>' + 'x'.repeat(30000) + '</li>'
    const r = htmlToItems('Big', `<ul>${items}</ul>`)
    expect(r.ok).toBe(true)
    if (r.ok) for (const item of r.items) expect(item.content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS)
  })

  it('refuses a document that would need too many articles', () => {
    const para = '<p>' + 'w'.repeat(14000) + '</p>'
    const r = htmlToItems('Huge', para.repeat(MAX_IMPORT_ARTICLES + 2))
    expect(r).toMatchObject({ ok: false, status: 413 })
  })

  it('says so when there is no text at all (a scanned file)', () => {
    expect(htmlToItems('Scan', '<p></p>')).toMatchObject({ ok: false, status: 422 })
    expect(htmlToItems('Scan', '')).toMatchObject({ ok: false, status: 422 })
  })

  it('clips a long title when adding the part suffix', () => {
    const para = '<p>' + 'word '.repeat(400) + '</p>'
    const r = htmlToItems('T'.repeat(300), para.repeat(30))
    expect(r.ok && r.items.every((i) => i.title.length <= 200)).toBe(true)
  })
})

describe('documentHtmlToItems', () => {
  it('takes the title from the first heading of a Word document', () => {
    const r = documentHtmlToItems('<h1>Refund policy</h1><p>Text</p>', 'x.docx')
    expect(r.ok && r.items[0].title).toBe('Refund policy')
    const r2 = documentHtmlToItems('<p>No heading</p>', 'Price_list.docx')
    expect(r2.ok && r2.items[0].title).toBe('Price list')
  })
})

describe('plainTextToItems', () => {
  it('keeps paragraphs and bullets', () => {
    const r = plainTextToItems('Hours', 'Open daily\n\n- Mon-Fri 9-6\n- Sat 9-1')
    expect(r.ok && r.items[0].content).toBe('Open daily\n\n- Mon-Fri 9-6\n- Sat 9-1')
  })
})

describe('csvToItems', () => {
  it('turns question and answer columns into Q&A drafts', () => {
    const r = csvToItems('Question,Answer\nDo you ship?,"Yes, worldwide"\nHours?,9 to 6\n,orphan', 'faq.csv')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items).toEqual([
        { title: 'Do you ship?', content: 'Yes, worldwide', content_html: null, kind: 'qa' },
        { title: 'Hours?', content: '9 to 6', content_html: null, kind: 'qa' },
      ])
      expect(r.skipped).toBe(1)
    }
  })

  it('makes one article from a CSV without those columns', () => {
    const r = csvToItems('Plan,Price\nBasic,10\nPro,25', 'plans.csv')
    expect(r.ok && r.items).toHaveLength(1)
    expect(r.ok && r.items[0]).toMatchObject({ title: 'plans', kind: 'article' })
    expect(r.ok && r.items[0].content).toContain('Basic | 10')
  })

  it('refuses an empty CSV', () => {
    expect(csvToItems('', 'a.csv')).toMatchObject({ ok: false, status: 422 })
  })

  it('does not mistake a spreadsheet-safe apostrophe for content', () => {
    const r = csvToItems("Plan,Price\nBasic,'=10", 'plans.csv')
    expect(r.ok && r.items[0].content).toContain('Basic | =10')
  })
})

describe('decodeTextFile / isProbablyBinary', () => {
  it('reads UTF-8 with or without a BOM and UTF-16', () => {
    const enc = new TextEncoder()
    expect(decodeTextFile(enc.encode('héllo 你好'))).toBe('héllo 你好')
    expect(decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('hi')]))).toBe('hi')
    expect(decodeTextFile(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe('hi')
    expect(decodeTextFile(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))).toBe('hi')
  })
  it('spots binary content', () => {
    expect(isProbablyBinary('hello world\nnormal text')).toBe(false)
    expect(isProbablyBinary(String.fromCharCode(0, 1, 2, 3, 4, 5, 6, 7) + 'abc')).toBe(true)
    expect(isProbablyBinary('')).toBe(false)
  })
})

describe('pdfTextToPlain', () => {
  it('joins the lines of a wrapped paragraph and keeps sentence breaks', () => {
    expect(pdfTextToPlain('We are open Monday to\nFriday from 9am to 6pm.\nWe close on public\nholidays.')).toBe(
      'We are open Monday to Friday from 9am to 6pm.\n\nWe close on public holidays.',
    )
  })

  it('keeps list items on their own lines and separate from the paragraph before', () => {
    expect(pdfTextToPlain('Bring the following:\n- your receipt\n- the item\n1. First\n2. Second')).toBe(
      'Bring the following:\n\n- your receipt\n- the item\n1. First\n2. Second',
    )
  })

  it('mends a word split across two lines and honours blank lines', () => {
    expect(pdfTextToPlain('refund-\nable within days\n\nNext part')).toBe('refundable within days\n\nNext part')
  })

  it('handles empty text', () => {
    expect(pdfTextToPlain('')).toBe('')
    expect(pdfTextToPlain('\n\n  \n')).toBe('')
  })
})
