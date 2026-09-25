// ============================================================
// Shared per-message action calls — the same mutations
// channel-thread.tsx's message list needs (react, pin, star, edit,
// remove, add-to-task) and the new global Mentions column needs for
// whichever channel a clicked mention happens to belong to (channelId
// varies per call there, not fixed to one open channel — the reason
// this is a set of plain functions, not a useCallback-based hook).
//
// Pure API wrappers: no local-state patching, no toasts. Callers own
// both — channel-thread.tsx patches its own messages/pins/tasks state
// and shows a toast on failure; the Mentions column's ThreadPanel
// already patches its own local parent/replies state, so it just needs
// the resolved data. Network/parse failures never throw — every
// function resolves to `{ ok: false, error? }` so callers don't need
// their own try/catch.
// ============================================================
import type { SembangMessage, SembangReactionSummary, SembangTask } from '@/types'

async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; data: Record<string, unknown> } | null> {
  try {
    const res = await fetch(url, init)
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, data }
  } catch {
    return null
  }
}

export async function reactToMessage(
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<{ ok: true; reactions: SembangReactionSummary[] } | { ok: false; error?: string }> {
  const result = await safeFetch(`/api/sembang/channels/${channelId}/messages/${messageId}/reactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji }),
  })
  if (!result || !result.ok) return { ok: false, error: result?.data?.error as string | undefined }
  return { ok: true, reactions: (result.data.reactions as SembangReactionSummary[]) ?? [] }
}

export async function toggleMessagePin(
  channelId: string,
  messageId: string,
  pinned: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const result = await safeFetch(`/api/sembang/channels/${channelId}/messages/${messageId}/pin`, {
    method: pinned ? 'DELETE' : 'POST',
  })
  if (!result || !result.ok) return { ok: false, error: result?.data?.error as string | undefined }
  return { ok: true }
}

export async function toggleMessageStar(
  channelId: string,
  messageId: string,
  starred: boolean,
): Promise<{ ok: boolean }> {
  const result = await safeFetch(`/api/sembang/channels/${channelId}/messages/${messageId}/star`, {
    method: starred ? 'DELETE' : 'POST',
  })
  return { ok: !!result?.ok }
}

export async function editMessage(
  channelId: string,
  messageId: string,
  body: string,
): Promise<{ ok: true; message: SembangMessage } | { ok: false; error?: string }> {
  const result = await safeFetch(`/api/sembang/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'edit', body }),
  })
  if (!result || !result.ok || !result.data.message) return { ok: false, error: result?.data?.error as string | undefined }
  return { ok: true, message: result.data.message as SembangMessage }
}

export async function removeMessage(
  channelId: string,
  messageId: string,
): Promise<{ ok: true; message: SembangMessage | null } | { ok: false; error?: string }> {
  const result = await safeFetch(`/api/sembang/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove' }),
  })
  if (!result || !result.ok) return { ok: false, error: result?.data?.error as string | undefined }
  return { ok: true, message: (result.data.message as SembangMessage | undefined) ?? null }
}

export async function addMessageToTask(
  channelId: string,
  message: SembangMessage,
): Promise<{ ok: true; task?: SembangTask } | { ok: false; error?: string }> {
  const title = message.body.length > 80 ? `${message.body.slice(0, 80)}…` : message.body
  const result = await safeFetch(`/api/sembang/channels/${channelId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, messageId: message.id }),
  })
  if (!result || !result.ok) return { ok: false, error: result?.data?.error as string | undefined }
  return { ok: true, task: result.data.task as SembangTask | undefined }
}
