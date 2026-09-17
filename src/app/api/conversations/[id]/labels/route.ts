import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  ConversationLabelWriteError,
  removeConversationLabel,
} from '@/lib/conversations/label-write';
import { addConversationLabelAndDispatch } from '@/lib/conversations/label-events';

function labelWriteErrorResponse(
  error: ConversationLabelWriteError
): NextResponse {
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: conversationId } = await params;
    const tagId = await readTagId(request);
    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 });
    }

    const { added } = await addConversationLabelAndDispatch({
      db: ctx.supabase,
      accountId: ctx.accountId,
      conversationId,
      tagId,
      appliedByUserId: ctx.userId,
    });

    return NextResponse.json({ ok: true, added });
  } catch (error) {
    if (error instanceof ConversationLabelWriteError) {
      return labelWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: conversationId } = await params;
    const tagId = await readTagId(request);
    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 });
    }

    await removeConversationLabel(ctx.supabase, {
      accountId: ctx.accountId,
      conversationId,
      tagId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ConversationLabelWriteError) {
      return labelWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}
