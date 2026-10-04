import { describe, expect, it } from 'vitest'

import { hostOf, normalizeBase, registeredUrls } from './registered-urls'

describe('registeredUrls', () => {
  const groups = registeredUrls('https://halo.vircle.tech/')
  const all = groups.flatMap((g) => g.items)

  it('builds every address from the one base, with no doubled slash', () => {
    expect(all.length).toBeGreaterThan(10)
    for (const i of all) {
      expect(i.url.startsWith('https://halo.vircle.tech')).toBe(true)
      expect(i.url.replace('https://', '')).not.toContain('//')
    }
  })

  it('has the callback addresses the app really serves', () => {
    const by = Object.fromEntries(all.map((i) => [i.id, i.url]))
    expect(by['whatsapp-webhook']).toBe('https://halo.vircle.tech/api/whatsapp/webhook')
    expect(by['messenger-redirect']).toBe('https://halo.vircle.tech/api/account/channels/messenger/oauth/callback')
    expect(by['instagram-webhook']).toBe('https://halo.vircle.tech/api/instagram/webhook')
    expect(by['jira-callback']).toBe('https://halo.vircle.tech/api/integrations/jira/callback')
    expect(by['vircle-chat-webhook']).toBe('https://halo.vircle.tech/api/vircle-chat/webhook')
    expect(by['supabase-site']).toBe('https://halo.vircle.tech')
    expect(by['supabase-redirect']).toBe('https://halo.vircle.tech/**')
  })

  it('marks only the mailbox notification address as registered by Halo itself', () => {
    expect(all.filter((i) => i.automatic).map((i) => i.id)).toEqual(['microsoft-notify'])
  })

  it('has unique ids', () => {
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length)
  })
})

describe('helpers', () => {
  it('normalizes a base and compares hosts', () => {
    expect(normalizeBase(' https://halo.vircle.tech// ')).toBe('https://halo.vircle.tech')
    expect(hostOf('https://CRM.vircle.tech/x')).toBe('crm.vircle.tech')
    expect(hostOf('not a url')).toBe('not a url')
  })
})
