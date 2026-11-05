import { NextResponse } from 'next/server';

import { requireCapability, toErrorResponse } from '@/lib/auth/account';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import {
  ContactTagWriteError,
  assertTagIsContactTag,
  removeContactTag,
} from '@/lib/contacts/tag-write';

function tagWriteErrorResponse(error: ContactTagWriteError): NextResponse {
  return NextResponse.json({ error: error.message }, { status: error.status });
}

async function readTagId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as {
    tag_id?: unknown;
  } | null;
  return typeof body?.tag_id === 'string' && body.tag_id.trim()
    ? body.tag_id.trim()
    : null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireCapability('contacts.view');
    const { id: contactId } = await params;
    const { searchParams } = new URL(req.url);
    const details = searchParams.get('details') === 'true';

    if (details) {
      const { data, error } = await ctx.supabase
        .from('contact_tags')
        .select('id, tag_id, tags(*)')
        .eq('contact_id', contactId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const tags = (data ?? [])
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ct.tags);
      return NextResponse.json({ tags });
    }

    const { data, error } = await ctx.supabase
      .from('contact_tags')
      .select('tag_id')
      .eq('contact_id', contactId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ tagIds: (data ?? []).map((r: { tag_id: string }) => r.tag_id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireCapability('contacts.edit');
    const { id: contactId } = await params;
    const tagId = await readTagId(request);
    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 });
    }

    // Only contact tags can be attached here; a conversation-only label is a 400.
    await assertTagIsContactTag(ctx.supabase, {
      accountId: ctx.accountId,
      tagId,
    });

    const result = await addContactTagAndDispatch({
      db: ctx.supabase,
      accountId: ctx.accountId,
      contactId,
      tagId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return tagWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireCapability('contacts.edit');
    const { id: contactId } = await params;
    const tagId = await readTagId(request);
    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 });
    }

    await removeContactTag(ctx.supabase, {
      accountId: ctx.accountId,
      contactId,
      tagId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return tagWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}
