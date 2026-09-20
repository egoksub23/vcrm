import { describe, it, expect, vi } from 'vitest'
import { extractFile } from './import-file'

// A one-page Word file ("Refund policy" heading + one paragraph with bold text)
// and a one-page PDF, built by hand so the real parsers are exercised.
const DOCX = 'UEsDBBQAAAAAADx3NF15bjPXrQEAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQUAAAAAAA8dzRdm/036ikBAAApAQAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAADx3NF1TBIv3iAEAAIgBAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnA+PHc6cFByPjx3OnBTdHlsZSB3OnZhbD0iSGVhZGluZzEiLz48L3c6cFByPjx3OnI+PHc6dD5SZWZ1bmQgcG9saWN5PC93OnQ+PC93OnI+PC93OnA+PHc6cD48dzpyPjx3OnQ+WW91IGdldCBhIDwvdzp0PjwvdzpyPjx3OnI+PHc6clByPjx3OmIvPjwvdzpyUHI+PHc6dD5mdWxsIHJlZnVuZDwvdzp0PjwvdzpyPjx3OnI+PHc6dD4gd2l0aGluIDE0IGRheXMuPC93OnQ+PC93OnI+PC93OnA+PC93OmJvZHk+PC93OmRvY3VtZW50PlBLAQIUABQAAAAAADx3NF15bjPXrQEAAK0BAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAAAPHc0XZv9N+opAQAAKQEAAAsAAAAAAAAAAAAAAIAB3gEAAF9yZWxzLy5yZWxzUEsBAhQAFAAAAAAAPHc0XVMEi/eIAQAAiAEAABEAAAAAAAAAAAAAAIABMAMAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAOcEAAAAAA=='
const PDF = 'JVBERi0xLjQNCjEgMCBvYmoNCjw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+Pg0KZW5kb2JqDQoyIDAgb2JqDQo8PCAvVHlwZSAvUGFnZXMgL0tpZHMgWzMgMCBSXSAvQ291bnQgMSA+Pg0KZW5kb2JqDQozIDAgb2JqDQo8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9Db250ZW50cyA0IDAgUiAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiA+Pg0KZW5kb2JqDQo0IDAgb2JqDQo8PCAvTGVuZ3RoIDg4ID4+DQpzdHJlYW0NCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKE9wZW5pbmcgaG91cnMpIFRqIDAgLTMwIFRkIChNb25kYXkgdG8gRnJpZGF5LCA5YW0gdG8gNnBtLikgVGogRVQNCmVuZHN0cmVhbQ0KZW5kb2JqDQo1IDAgb2JqDQo8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4NCmVuZG9iag0KeHJlZg0KMCA2DQowMDAwMDAwMDAwIDY1NTM1IGYgDQowMDAwMDAwMDA5IDAwMDAwIG4gDQowMDAwMDAwMDU4IDAwMDAwIG4gDQowMDAwMDAwMTE1IDAwMDAwIG4gDQowMDAwMDAwMjQxIDAwMDAwIG4gDQowMDAwMDAwMzc5IDAwMDAwIG4gDQp0cmFpbGVyDQo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+DQpzdGFydHhyZWYNCjQ0OQ0KJSVFT0Y='

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const enc = (s: string) => new TextEncoder().encode(s)

describe('extractFile', () => {
  it('reads a Word (.docx) file with its headings and formatting', async () => {
    const r = await extractFile(bytes(DOCX), 'policy.docx', '')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items).toHaveLength(1)
      expect(r.items[0].title).toBe('Refund policy')
      expect(r.items[0].content).toBe('Refund policy\n\nYou get a full refund within 14 days.')
      expect(r.items[0].content_html).toContain('<strong>full refund</strong>')
    }
  })

  it('reads the text of a PDF', async () => {
    const r = await extractFile(bytes(PDF), 'Opening_hours.pdf', 'application/pdf')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items[0].title).toBe('Opening hours')
      expect(r.items[0].content).toContain('Monday to Friday, 9am to 6pm.')
    }
  })

  it('reports a damaged or password-protected PDF and a bad Word file readably', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await extractFile(enc('not a pdf at all'), 'x.pdf', '')).toMatchObject({ ok: false, status: 422 })
    expect(await extractFile(enc('not a zip'), 'x.docx', '')).toMatchObject({ ok: false, status: 422 })
    warn.mockRestore()
  })

  it('reads text, Markdown and CSV files', async () => {
    const txt = await extractFile(enc('Open daily.\n\n- Mon-Fri\n- Sat'), 'hours.txt', 'text/plain')
    expect(txt.ok && txt.items[0].content).toBe('Open daily.\n\n- Mon-Fri\n- Sat')
    const md = await extractFile(enc('# Returns\n\nWithin **14** days.'), 'r.md', '')
    expect(md.ok && md.items[0].title).toBe('Returns')
    const csv = await extractFile(enc('Question,Answer\nHi?,Hello'), 'faq.csv', 'text/csv')
    expect(csv.ok && csv.items[0]).toMatchObject({ kind: 'qa', title: 'Hi?', content: 'Hello' })
  })

  it('refuses what it cannot read, with a message that says what to do', async () => {
    expect(await extractFile(enc('x'), 'a.doc', 'application/msword')).toMatchObject({ ok: false, status: 415 })
    expect(await extractFile(enc('x'), 'a.pptx', '')).toMatchObject({ ok: false, status: 415 })
    expect(await extractFile(new Uint8Array(0), 'a.txt', '')).toMatchObject({ ok: false, status: 422 })
    const bin = new Uint8Array(200).map((_, i) => i % 8)
    expect(await extractFile(bin, 'a.txt', '')).toMatchObject({ ok: false, status: 415 })
  })

  it('refuses a file over the size limit', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    expect(await extractFile(big, 'a.pdf', '')).toMatchObject({ ok: false, status: 413 })
  })
})
