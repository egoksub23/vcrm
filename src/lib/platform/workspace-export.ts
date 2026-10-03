// ============================================================
// Workspace export (migration 153): everything the workspace owns, as one zip.
//
//   manifest.json      what is in the archive, row counts, what was left out and why
//   README.txt         the same in words, for the person who opens it
//   data/<table>.csv   every table with rows (UTF-8 with BOM, one header line, RFC 4180)
//   files/<bucket>/..  the workspace's stored files (attachments, media, brand images)
//
// The list of tables comes from the database (workspace_export_manifest): every
// table keyed by the workspace, the children reached through a parent, and the
// workspace row itself. Secrets are never exported: tokens, signing secrets, key
// hashes and embeddings are excluded by column name and by table in the SQL, so
// a table added later cannot leak one by being forgotten here.
//
// Built as a stream (fflate), a page at a time, so a large workspace does not
// have to fit in memory. Rows are read in physical order; a workspace that is
// being written to while it is exported can give a row twice or miss one, so for
// a deletion the app exports after the workspace is suspended.
// ============================================================
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate'
import type { SupabaseClient } from '@supabase/supabase-js'

import { toCsv } from '@/lib/csv'

const PAGE = 500
const FILE_PAGE = 200

interface ManifestEntry {
  table: string
  parent: string | null
  fk: string | null
  columns: string[] | null
}

export interface ExportOptions {
  /** Include the stored files (default true). */
  files?: boolean
  /** The workspace's name, for the README. */
  accountName?: string
  now?: Date
}

export interface ExportSummary {
  tables: Record<string, number>
  files: number
  filesFailed: string[]
}

/** One cell as text: null is empty, objects and arrays are JSON. */
export function exportCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** The zip, as chunks. `summary` is filled in as it goes and complete when the generator ends. */
export async function* workspaceExportChunks(
  db: SupabaseClient,
  accountId: string,
  opts: ExportOptions = {},
  summary: ExportSummary = { tables: {}, files: 0, filesFailed: [] },
): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = []
  let failure: Error | null = null
  const zip = new Zip((err, chunk) => {
    if (err) failure = err
    else out.push(chunk)
  })
  function* flush(): Generator<Uint8Array> {
    if (failure) throw failure
    while (out.length > 0) yield out.shift() as Uint8Array
  }
  const now = opts.now ?? new Date()

  const { data: manifestData, error: manifestError } = await db.rpc('workspace_export_manifest')
  if (manifestError) throw new Error(`export manifest: ${manifestError.message}`)
  const manifest = (manifestData ?? []) as ManifestEntry[]

  // ---- data ----
  for (const entry of manifest) {
    const columns = entry.columns ?? []
    if (columns.length === 0) continue
    let after: string | null = null
    let file: ZipDeflate | null = null
    let count = 0
    for (;;) {
      const { data, error } = await db.rpc('workspace_export_rows', {
        p_account: accountId,
        p_table: entry.table,
        p_after: after,
        p_limit: PAGE,
      })
      if (error) throw new Error(`export ${entry.table}: ${error.message}`)
      const page = data as { rows: Record<string, unknown>[]; last: string | null }
      if (!page.rows || page.rows.length === 0) break
      if (!file) {
        file = new ZipDeflate(`data/${entry.table}.csv`, { level: 6 })
        zip.add(file)
        file.push(strToU8('﻿' + toCsv([columns])), false)
      }
      file.push(strToU8(toCsv(page.rows.map((r) => columns.map((c) => exportCell(r[c]))))), false)
      count += page.rows.length
      after = page.last
      yield* flush()
      if (page.rows.length < PAGE || !after) break
    }
    if (file) {
      file.push(new Uint8Array(0), true)
      summary.tables[entry.table] = count
    }
    yield* flush()
  }

  // ---- stored files ----
  if (opts.files !== false) {
    const prefix = `account-${accountId}/`
    let afterBucket: string | null = null
    let afterName: string | null = null
    for (;;) {
      const { data, error } = await db.rpc('storage_objects_by_prefix', {
        p_prefix: prefix,
        p_after_bucket: afterBucket,
        p_after_name: afterName,
        p_limit: FILE_PAGE,
      })
      if (error) throw new Error(`export files: ${error.message}`)
      const objects = (data ?? []) as { bucket: string; name: string; size: number }[]
      for (const o of objects) {
        const path = `files/${o.bucket}/${o.name.slice(prefix.length)}`
        try {
          const { data: blob, error: dlError } = await db.storage.from(o.bucket).download(o.name)
          if (dlError || !blob) throw new Error(dlError?.message ?? 'empty')
          // Files are already compressed (images, video, pdf): store them.
          const f = new ZipPassThrough(path)
          zip.add(f)
          f.push(new Uint8Array(await blob.arrayBuffer()), true)
          summary.files += 1
        } catch {
          summary.filesFailed.push(`${o.bucket}/${o.name}`)
        }
        yield* flush()
      }
      if (objects.length < FILE_PAGE) break
      const last = objects[objects.length - 1]
      afterBucket = last.bucket
      afterName = last.name
    }
  }

  // ---- manifest and README, last so they can state what really went in ----
  const manifestFile = new ZipDeflate('manifest.json', { level: 6 })
  zip.add(manifestFile)
  manifestFile.push(
    strToU8(
      JSON.stringify(
        {
          workspace: opts.accountName ?? null,
          workspaceId: accountId,
          exportedAt: now.toISOString(),
          tables: summary.tables,
          files: summary.files,
          filesNotExported: summary.filesFailed,
          notIncluded: [
            'passwords and login records (held by the sign-in service, not the workspace)',
            'channel tokens, API keys and webhook secrets',
            'search vectors derived from knowledge articles',
            'one-time codes and raw provider events',
          ],
        },
        null,
        2,
      ),
    ),
    true,
  )
  const readme = new ZipDeflate('README.txt', { level: 6 })
  zip.add(readme)
  readme.push(
    strToU8(
      [
        `Workspace export${opts.accountName ? `: ${opts.accountName}` : ''}`,
        `Created ${now.toISOString()}`,
        '',
        'data/    one CSV file per table that has rows. Open them in a spreadsheet; the first line is the column names.',
        'files/   the files stored for the workspace, in the folders they were kept in.',
        'manifest.json   how many rows each table holds and what was left out.',
        '',
        'Not included: channel tokens, API keys, webhook secrets and signing secrets (so the export is safe to hand over),',
        'search vectors that are derived from your articles, and anything held by the sign-in service such as passwords.',
        summary.filesFailed.length > 0
          ? `\n${summary.filesFailed.length} file(s) could not be read and are listed in manifest.json.`
          : '',
        '',
      ].join('\n'),
    ),
    true,
  )
  zip.end()
  yield* flush()
}

/** The same, as a web stream for a Response. */
export function workspaceExportStream(
  db: SupabaseClient,
  accountId: string,
  opts: ExportOptions = {},
): ReadableStream<Uint8Array> {
  const gen = workspaceExportChunks(db, accountId, opts)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (err) {
        console.error('[workspace export] failed:', err)
        controller.error(err)
      }
    },
    async cancel() {
      await gen.return(undefined)
    },
  })
}

/** A file name for the download: the workspace's name made plain ASCII (it goes in a header), and the date. */
export function exportFileName(accountName: string | null | undefined, now: Date = new Date()): string {
  const slug = (accountName ?? 'workspace')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${slug || 'workspace'}-export-${now.toISOString().slice(0, 10)}.zip`
}
