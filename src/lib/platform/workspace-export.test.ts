import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import type { SupabaseClient } from '@supabase/supabase-js'

import { exportCell, exportFileName, workspaceExportChunks, type ExportSummary } from './workspace-export'

const ACCOUNT = 'a067c4ed-4f53-4c1c-a007-bf6f3bc4d86b'

interface FakeOptions {
  manifest: unknown
  /** table -> pages, each page a list of rows */
  pages: Record<string, Record<string, unknown>[][]>
  objects?: { bucket: string; name: string; size: number }[]
  failDownload?: string[]
}

function fakeDb(o: FakeOptions): SupabaseClient {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'workspace_export_manifest') return { data: o.manifest, error: null }
      if (name === 'workspace_export_rows') {
        const pages = o.pages[args.p_table as string] ?? []
        const index = args.p_after ? Number(args.p_after) : 0
        const rows = pages[index] ?? []
        return { data: { rows, last: rows.length > 0 ? String(index + 1) : null }, error: null }
      }
      if (name === 'storage_objects_by_prefix') {
        const all = o.objects ?? []
        const after = args.p_after_name as string | null
        return { data: all.filter((x) => after === null || x.name > after), error: null }
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    },
    storage: {
      from: (bucket: string) => ({
        download: async (name: string) =>
          o.failDownload?.includes(name)
            ? { data: null, error: { message: 'gone' } }
            : { data: new Blob([`bytes of ${bucket}/${name}`]), error: null },
      }),
    },
  } as unknown as SupabaseClient
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Record<string, Uint8Array>> {
  const parts: Uint8Array[] = []
  for await (const c of gen) parts.push(c)
  const total = parts.reduce((n, p) => n + p.length, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.length
  }
  return unzipSync(all)
}

describe('exportCell', () => {
  it('turns values into text: null empty, objects JSON, the rest as written', () => {
    expect(exportCell(null)).toBe('')
    expect(exportCell(undefined)).toBe('')
    expect(exportCell('hello, "world"')).toBe('hello, "world"')
    expect(exportCell(42)).toBe('42')
    expect(exportCell(false)).toBe('false')
    expect(exportCell({ a: 1 })).toBe('{"a":1}')
    expect(exportCell(['x', 'y'])).toBe('["x","y"]')
  })
})

describe('exportFileName', () => {
  it('is plain ASCII with the date, whatever the workspace is called', () => {
    const d = new Date('2026-10-04T10:00:00Z')
    expect(exportFileName('Café Ünïcode & Co.', d)).toBe('Cafe-Unicode-Co-export-2026-10-04.zip')
    expect(exportFileName('日本語', d)).toBe('workspace-export-2026-10-04.zip')
    expect(exportFileName(null, d)).toBe('workspace-export-2026-10-04.zip')
  })
})

describe('workspaceExportChunks', () => {
  const manifest = [
    { table: 'contacts', parent: null, fk: null, columns: ['id', 'name', 'tags'] },
    { table: 'empty_table', parent: null, fk: null, columns: ['id'] },
    { table: 'no_columns', parent: null, fk: null, columns: [] },
  ]

  it('writes a CSV per table with rows (BOM, header, every page), the files, a manifest and a README', async () => {
    const summary: ExportSummary = { tables: {}, files: 0, filesFailed: [] }
    const db = fakeDb({
      manifest,
      pages: {
        contacts: [
          Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, name: `Name ${i}`, tags: ['a'] })),
          [{ id: 'last', name: 'Zoë, "the" last', tags: null }],
        ],
      },
      objects: [
        { bucket: 'chat-media', name: `account-${ACCOUNT}/kb/a.png`, size: 10 },
        { bucket: 'chat-media', name: `account-${ACCOUNT}/broken.bin`, size: 10 },
      ],
      failDownload: [`account-${ACCOUNT}/broken.bin`],
    })
    const zip = await collect(workspaceExportChunks(db, ACCOUNT, { accountName: 'Acme', now: new Date('2026-10-04T00:00:00Z') }, summary))

    expect(Object.keys(zip).sort()).toEqual(['README.txt', 'data/contacts.csv', 'files/chat-media/kb/a.png', 'manifest.json'])
    // UTF-8 byte order mark first (so a spreadsheet reads the accents), then the text
    expect([...zip['data/contacts.csv'].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const csv = strFromU8(zip['data/contacts.csv'])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('id,name,tags')
    expect(lines[1]).toBe('c0,Name 0,"[""a""]"')
    expect(lines).toHaveLength(1 + 501 + 1) // header, 501 rows, trailing empty after the last CRLF
    expect(lines[501]).toBe('last,"Zoë, ""the"" last",')

    expect(strFromU8(zip['files/chat-media/kb/a.png'])).toBe(`bytes of chat-media/account-${ACCOUNT}/kb/a.png`)
    const m = JSON.parse(strFromU8(zip['manifest.json']))
    expect(m.workspace).toBe('Acme')
    expect(m.tables).toEqual({ contacts: 501 })
    expect(m.files).toBe(1)
    expect(m.filesNotExported).toEqual([`chat-media/account-${ACCOUNT}/broken.bin`])
    expect(m.notIncluded.join(' ')).toMatch(/tokens, API keys/)
    expect(strFromU8(zip['README.txt'])).toContain('1 file(s) could not be read')
    expect(summary).toEqual({ tables: { contacts: 501 }, files: 1, filesFailed: [`chat-media/account-${ACCOUNT}/broken.bin`] })
  })

  it('leaves the files out when asked, and still writes the data', async () => {
    const db = fakeDb({
      manifest,
      pages: { contacts: [[{ id: 'c', name: 'N', tags: null }]] },
      objects: [{ bucket: 'chat-media', name: `account-${ACCOUNT}/x.png`, size: 1 }],
    })
    const zip = await collect(workspaceExportChunks(db, ACCOUNT, { files: false }))
    expect(Object.keys(zip).sort()).toEqual(['README.txt', 'data/contacts.csv', 'manifest.json'])
  })

  it('fails loudly when the database cannot give a page, rather than writing a short export', async () => {
    const broken = {
      rpc: async (name: string) =>
        name === 'workspace_export_manifest'
          ? { data: manifest, error: null }
          : { data: null, error: { message: 'timeout' } },
    } as unknown as SupabaseClient
    await expect(collect(workspaceExportChunks(broken, ACCOUNT))).rejects.toThrow(/export contacts: timeout/)
  })
})
