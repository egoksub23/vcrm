import type { MentionKind } from './mentions'
import type { MentionAction } from './mention-resolve'
import type { PostCommentResult } from './comment-write'

// Browser side of the ticket mention routes (migration 095).

export type PostCommentResponse =
  | { ok: true; data: PostCommentResult }
  | { ok: false; status: number; error: string }

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : ''
}

export async function postTicketCommentRequest(
  ticketId: string,
  input: { body: string; mentions: string[]; teams: string[]; kind: MentionKind },
): Promise<PostCommentResponse> {
  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) return { ok: false, status: res.status, error: await readError(res) }
    return { ok: true, data: (await res.json()) as PostCommentResult }
  } catch {
    return { ok: false, status: 0, error: '' }
  }
}

export type MentionActionResponse = { ok: true } | { ok: false; status: number; error: string }

export async function mentionActionRequest(
  ticketId: string,
  mentionId: string,
  action: MentionAction,
): Promise<MentionActionResponse> {
  try {
    const res = await fetch(
      `/api/tickets/${encodeURIComponent(ticketId)}/mentions/${encodeURIComponent(mentionId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) },
    )
    if (!res.ok) return { ok: false, status: res.status, error: await readError(res) }
    return { ok: true }
  } catch {
    return { ok: false, status: 0, error: '' }
  }
}
