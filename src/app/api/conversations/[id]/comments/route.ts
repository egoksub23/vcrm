import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CommentWriteError, postInternalComment } from '@/lib/conversations/comment-write';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: conversationId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { text?: unknown; mentions?: unknown }
      | null;

    const text = typeof body?.text === 'string' ? body.text : '';
    const mentions = Array.isArray(body?.mentions)
      ? body.mentions.filter((m): m is string => typeof m === 'string')
      : [];

    const message = await postInternalComment(ctx.supabase, {
      accountId: ctx.accountId,
      conversationId,
      userId: ctx.userId,
      text,
      mentions,
    });

    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    if (error instanceof CommentWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return toErrorResponse(error);
  }
}
