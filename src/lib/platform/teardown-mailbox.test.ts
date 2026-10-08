import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Workspace teardown switches off what the app registered on other services. A mailbox that is not used for the customer care inbox (migration 179) has
// nothing registered: the teardown says so and does not call Google or Microsoft for it.

const h = vi.hoisted(() => ({
  stopWatch: vi.fn(async () => true),
  deleteSubscription: vi.fn(async () => true),
  gmail: null as Record<string, unknown> | null,
  email: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/comments/meta-comments', () => ({ unsubscribePage: async () => undefined }))
vi.mock('@/lib/gmail/gmail-api', () => ({ stopWatch: h.stopWatch }))
vi.mock('@/lib/gmail/token', () => ({ getValidAccessToken: async () => 'g-token' }))
vi.mock('@/lib/ms365/mail-api', () => ({ deleteSubscription: h.deleteSubscription }))
vi.mock('@/lib/ms365/token', () => ({ getValidAccessToken: async () => 'm-token' }))
vi.mock('@/lib/jira/connection', () => ({ disconnect: async () => ({ webhooksRemoved: true }) }))
vi.mock('@/lib/jira/oauth', () => ({ isJiraConfigured: () => false }))
vi.mock('@/lib/jira/service', () => ({ clientForConnection: () => null, jiraStore: () => ({ getConnectionByAccount: async () => null }) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ unsubscribeWabaFromApp: async () => undefined }))

import { teardownWorkspaceChannels } from './teardown'

function db(): SupabaseClient {
  return {
    from: (table: string) => {
      const data = table === 'gmail_config' ? h.gmail : table === 'email_config' ? h.email : null
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [] }),
      }
      return b
    },
  } as unknown as SupabaseClient
}

beforeEach(() => {
  h.gmail = null
  h.email = null
})

describe('workspace teardown: mailboxes', () => {
  it('stops the Gmail watch and deletes the Microsoft 365 subscription of a mailbox used for the customer care inbox', async () => {
    h.gmail = { id: 'g', inbox_enabled: true }
    h.email = { id: 'e', inbox_enabled: true, subscription_id: 'sub-1' }
    const r = await teardownWorkspaceChannels(db(), 'A')
    expect(r.gmail).toBe('ok')
    expect(r.email).toBe('ok')
    expect(h.stopWatch).toHaveBeenCalledTimes(1)
    expect(h.deleteSubscription).toHaveBeenCalledWith({ accessToken: 'm-token', subscriptionId: 'sub-1' })
  })

  it('calls neither service for a mailbox that is not used for the customer care inbox, and says why, not "failed"', async () => {
    h.gmail = { id: 'g', inbox_enabled: false }
    h.email = { id: 'e', inbox_enabled: false, subscription_id: null }
    const r = await teardownWorkspaceChannels(db(), 'A')
    expect(r.gmail).toBe('inbox off, no watch')
    expect(r.email).toBe('inbox off, no subscription')
    expect(h.stopWatch).not.toHaveBeenCalled()
    expect(h.deleteSubscription).not.toHaveBeenCalled()
  })

  it('reports a mailbox that is not connected', async () => {
    const r = await teardownWorkspaceChannels(db(), 'A')
    expect(r.gmail).toBe('not connected')
    expect(r.email).toBe('not connected')
  })

  it('still deletes a subscription that exists even if the flag reads off (it must not be left behind)', async () => {
    h.email = { id: 'e', inbox_enabled: false, subscription_id: 'sub-left' }
    const r = await teardownWorkspaceChannels(db(), 'A')
    expect(r.email).toBe('ok')
    expect(h.deleteSubscription).toHaveBeenCalledTimes(1)
  })
})
