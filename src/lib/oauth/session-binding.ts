// ============================================================
// Binding an OAuth callback to the signed-in session.
//
// A channel connection starts with a pending row holding a random state
// token, minted for one workspace and one person. The provider's redirect
// back to us carries that state and nothing else, so on its own the state
// is a bearer token: whoever's browser lands on the callback URL completes
// the connection. A forwarded or pasted callback link could therefore
// finish a connection the person never started (or attach the wrong
// provider account to a workspace).
//
// The callback is a normal browser navigation, so it carries the session
// cookie. The person finishing the flow must be the person who started it,
// signed in to the workspace the row was minted for, and still allowed to
// connect channels. Jira does the same with its signed state.
// ============================================================

import { requireCapability } from '@/lib/auth/account'

export interface PendingOwner {
  account_id: string
  initiated_by_user_id: string
}

/**
 * True when the browser's session is the person (and workspace) the pending
 * row was minted for and that person still holds `capability`. False when
 * signed out, signed in as someone else, or no longer permitted. Never throws.
 */
export async function sessionOwnsPending(
  pending: PendingOwner,
  capability = 'channels.manage',
): Promise<boolean> {
  try {
    const ctx = await requireCapability(capability)
    return ctx.userId === pending.initiated_by_user_id && ctx.accountId === pending.account_id
  } catch {
    return false
  }
}
