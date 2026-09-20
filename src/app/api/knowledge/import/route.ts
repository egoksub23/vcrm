import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireAnyCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { extractFile } from '@/lib/knowledge/import-file'
import {
  MAX_IMPORT_FILE_BYTES,
  pairsToItems,
  type ExtractResult,
} from '@/lib/knowledge/import-extract'
import {
  createSource,
  parseImportOptions,
  saveImportedDrafts,
  type ImportOptions,
} from '@/lib/knowledge/import-save'
import {
  PageFetchError,
  checksumOf,
  extractReadablePage,
  fetchWebPage,
  fitPageToArticle,
} from '@/lib/knowledge/web-page'

// A multipart body is read into memory, so refuse a huge one up front. The
// allowance beyond the file limit covers the other form fields.
const MAX_BODY_BYTES = MAX_IMPORT_FILE_BYTES + 512 * 1024

/**
 * POST /api/knowledge/import   (agent+)
 *
 * Adds articles from somewhere else. Every import lands as DRAFTS, whoever
 * runs it, for an admin to read and publish.
 *
 *  - JSON `{ kind: 'qa', pairs: [{ question, answer }], language, collection_id }`
 *    one Q&A draft per pair (at most 200)
 *  - JSON `{ kind: 'url', url, language, collection_id }`
 *    a web page, read into one draft and remembered as a source so it can be
 *    re-synced (POST /api/knowledge/[id]/resync)
 *  - multipart `kind=file`, `file`, `language`, `collection_id`
 *    text, Markdown, CSV (question/answer columns make Q&A drafts), Word
 *    (.docx) or PDF. A long document becomes several drafts.
 *
 * Returns `{ documents: [{ id, title }], skipped?, truncated? }`.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireAnyCapability(['knowledge.draft', 'knowledge.publish'])
    const limit = checkRateLimit(`kb-import:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const ctx = { accountId, userId }

    const contentType = request.headers.get('content-type') ?? ''
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      const declared = Number(request.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return NextResponse.json({ error: 'This file is too large to import.' }, { status: 413 })
      }
      const form = await request.formData().catch(() => null)
      if (!form) return NextResponse.json({ error: 'The upload could not be read.' }, { status: 400 })
      if (form.get('kind') !== 'file') {
        return NextResponse.json({ error: 'kind must be file' }, { status: 400 })
      }
      const opts = parseImportOptions(form.get('language'), form.get('collection_id'))
      if (!opts.ok) return NextResponse.json({ error: opts.error }, { status: 400 })
      const file = form.get('file')
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'Choose a file to import.' }, { status: 400 })
      }
      if (file.size > MAX_IMPORT_FILE_BYTES) {
        return NextResponse.json({ error: 'This file is too large to import.' }, { status: 413 })
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const extracted = await extractFile(bytes, file.name, file.type)
      if (!extracted.ok) return NextResponse.json({ error: extracted.error }, { status: extracted.status })

      const sourceId = await createSource(supabase, ctx, {
        kind: 'file',
        name: file.name.slice(0, 200),
        checksum: createHash('sha256').update(bytes).digest('hex'),
      })
      return await finish(supabase, ctx, extracted, { ...opts, sourceId })
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Send JSON or a file upload.' }, { status: 400 })
    }
    const opts = parseImportOptions(body.language, body.collection_id)
    if (!opts.ok) return NextResponse.json({ error: opts.error }, { status: 400 })

    if (body.kind === 'qa') {
      const items = pairsToItems(body.pairs)
      if (!items.ok) return NextResponse.json({ error: items.error }, { status: items.status })
      return await finish(supabase, ctx, items, opts)
    }

    if (body.kind === 'url') {
      if (typeof body.url !== 'string' || !body.url.trim()) {
        return NextResponse.json({ error: 'Enter the web address of the page.' }, { status: 400 })
      }
      let fetched
      try {
        fetched = await fetchWebPage(body.url)
      } catch (err) {
        if (err instanceof PageFetchError) return NextResponse.json({ error: err.message }, { status: err.status })
        throw err
      }
      const page = extractReadablePage(fetched.html, fetched.url)
      if (!page) {
        return NextResponse.json(
          { error: 'No readable text was found on that page. If it builds its content with JavaScript, copy the text into a new article instead.' },
          { status: 422 },
        )
      }
      const fit = fitPageToArticle(page)
      const sourceId = await createSource(supabase, ctx, {
        kind: 'url',
        name: page.title,
        url: fetched.url,
        checksum: checksumOf(page.text),
      })
      const result = await finish(
        supabase,
        ctx,
        {
          ok: true,
          skipped: 0,
          items: [{ title: fit.title, content: fit.text, content_html: fit.html, kind: 'article' }],
        },
        { ...opts, sourceId },
        fit.truncated,
      )
      return result
    }

    return NextResponse.json({ error: 'kind must be qa, url or file' }, { status: 400 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function finish(
  supabase: Parameters<typeof saveImportedDrafts>[0],
  ctx: { accountId: string; userId: string },
  extracted: Extract<ExtractResult, { ok: true }>,
  opts: ImportOptions & { sourceId?: string | null },
  truncated = false,
) {
  const saved = await saveImportedDrafts(supabase, ctx, extracted.items, opts)
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status })
  return NextResponse.json({
    documents: saved.documents,
    ...(extracted.skipped > 0 ? { skipped: extracted.skipped } : {}),
    ...(truncated ? { truncated: true } : {}),
  })
}
