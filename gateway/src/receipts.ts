// ============================================================
// Support's side of the user's own messages (contract 1.2, section 4.1), and the typing indicator to the app.
//
//   delivered   the gateway sets it itself when Halo accepts the message's `message.inbound` event
//   read        Halo says an agent read it (`POST /v1/receipts`)
//
// A status only moves forward, the app is told about each change on its live connections, and a user who is
// offline sees the new status the next time they connect (a replayed message carries its current status).
// ============================================================

import { receiptFrame, typingFrame } from './frames'
import type { Hub } from './hub'
import type { Store, Subject } from './store'

export async function applySupportStatus(
  s: { store: Store; hub: Hub },
  subject: Subject,
  serverIds: string[],
  status: 'delivered' | 'read',
): Promise<number> {
  const changed = await s.store.applySupportStatus(subject, serverIds, status)
  if (changed.length > 0) s.hub.send(subject.user.id, receiptFrame(subject.conversation.id, status, changed))
  return changed.length
}

/** An agent is typing: show it on the user's live connections. Returns how many it reached. */
export function showAgentTyping(s: { hub: Hub }, subject: Subject): number {
  return s.hub.send(subject.user.id, typingFrame(subject.conversation.id))
}
