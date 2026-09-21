// ============================================================
// GET /api/contacts/export  (contacts.edit, the same capability as Import)
//
// The account's contacts as a CSV download, streamed in pages so a large
// list is never truncated at the database's 1,000-row response cap.
// Optional filters mirror the Contacts page: `q` (name / phone / email
// search) and `tag_ids` (comma separated, contacts with ANY of them).
// Columns: phone, name, email, company, tags, created_at. Cells that start
// with = + - @ are prefixed with an apostrophe (spreadsheet formula guard).
// ============================================================

import { requireCapability, toErrorResponse } from '@/lib/auth/account';
import {
  CONTACT_EXPORT_MAX_ROWS,
  CONTACT_EXPORT_PAGE_SIZE,
  contactExportHeaderLine,
  contactExportLines,
  parseTagIdsParam,
  sanitizeContactSearch,
  type ContactExportRow,
} from '@/lib/contacts/export-csv';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const SELECT = 'id, phone, name, email, company, created_at, contact_tags(tag_id)';

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability('contacts.edit');
    const limit = checkRateLimit(
      `contacts-export:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const params = new URL(request.url).searchParams;
    const search = sanitizeContactSearch(params.get('q'));
    const tagIds = parseTagIdsParam(params.get('tag_ids'));

    // Tag id -> name, once. Only approved, not-deleted tags are exported.
    const tagNames = new Map<string, string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await ctx.supabase
        .from('tags')
        .select('id, name')
        .eq('account_id', ctx.accountId)
        .eq('approval_status', 'approved')
        .is('deleted_at', null)
        .order('id')
        .range(from, from + 999);
      if (error) throw error;
      const rows = (data ?? []) as { id: string; name: string }[];
      for (const r of rows) tagNames.set(r.id, r.name);
      if (rows.length < 1000) break;
    }

    const encoder = new TextEncoder();
    let offset = 0;
    let started = false;
    let done = false;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (!started) {
            started = true;
            // BOM so Excel reads non-ASCII names (Korean, accented) as UTF-8.
            controller.enqueue(encoder.encode('﻿' + contactExportHeaderLine()));
          }
          if (done || offset >= CONTACT_EXPORT_MAX_ROWS) {
            controller.close();
            return;
          }
          const take = Math.min(CONTACT_EXPORT_PAGE_SIZE, CONTACT_EXPORT_MAX_ROWS - offset);

          // A second, aliased inner join on contact_tags narrows to contacts
          // with ANY selected tag while `contact_tags(tag_id)` still returns
          // the contact's full tag set. Same pattern as GET /api/v1/contacts.
          let query = ctx.supabase
            .from('contacts')
            .select(
              tagIds.length > 0
                ? `${SELECT}, tag_filter:contact_tags!inner(tag_id)`
                : SELECT
            )
            .eq('account_id', ctx.accountId);
          if (tagIds.length > 0) query = query.in('tag_filter.tag_id', tagIds);
          if (search) {
            const like = `%${search}%`;
            query = query.or(
              `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`
            );
          }
          const { data, error } = await query
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(offset, offset + take - 1);
          if (error) throw error;

          const rows = (data ?? []) as unknown as ContactExportRow[];
          if (rows.length > 0) {
            controller.enqueue(encoder.encode(contactExportLines(rows, tagNames)));
            offset += rows.length;
          }
          if (rows.length < take) done = true;
        } catch (err) {
          console.error('[GET /api/contacts/export] stream error:', err);
          controller.error(err);
        }
      },
    });

    const day = new Date().toISOString().slice(0, 10);
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="contacts-${day}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
