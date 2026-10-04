// ============================================================
// Every address Halo expects to be registered with another service, at the
// deployment's own address. Meta, Microsoft, Google, TikTok, Atlassian and
// Supabase each hold one or more of them, and a change of Halo's address leaves
// each of those pointing at the old one. Settings > Channels shows this list, ready
// to copy, so a move (or a new environment) is a copy-and-paste job and not a
// hunt through the code. The provider names are the labels on their own consoles,
// so they are kept as the providers write them.
// ============================================================

export interface RegisteredUrl {
  id: string
  /** What the address is, in the provider's words. */
  label: string
  /** Where to enter it. */
  where: string
  url: string
  /** Halo registers this one itself (nothing to copy); listed for completeness. */
  automatic?: boolean
}

export interface RegisteredUrlGroup {
  id: string
  title: string
  items: RegisteredUrl[]
}

/** `https://halo.vircle.tech` with no trailing slash. */
export function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

export function registeredUrls(rawBase: string): RegisteredUrlGroup[] {
  const base = normalizeBase(rawBase)
  const u = (path: string) => `${base}${path}`
  return [
    {
      id: 'meta',
      title: 'Meta (WhatsApp, Messenger, Instagram)',
      items: [
        { id: 'whatsapp-webhook', label: 'WhatsApp webhook callback URL', where: 'Meta app > WhatsApp > Configuration > Callback URL', url: u('/api/whatsapp/webhook') },
        { id: 'messenger-webhook', label: 'Messenger webhook callback URL', where: 'Meta app > Messenger > Webhooks > Callback URL', url: u('/api/messenger/webhook') },
        { id: 'instagram-webhook', label: 'Instagram webhook callback URL', where: 'Meta app > Instagram > Webhooks > Callback URL', url: u('/api/instagram/webhook') },
        { id: 'messenger-redirect', label: 'Messenger sign-in redirect URI', where: 'Meta app > Facebook Login > Settings > Valid OAuth Redirect URIs', url: u('/api/account/channels/messenger/oauth/callback') },
        { id: 'instagram-redirect', label: 'Instagram sign-in redirect URI', where: 'Meta app > Facebook Login > Settings > Valid OAuth Redirect URIs', url: u('/api/account/channels/instagram/oauth/callback') },
      ],
    },
    {
      id: 'microsoft',
      title: 'Microsoft 365 email',
      items: [
        { id: 'microsoft-redirect', label: 'Sign-in redirect URI', where: 'Entra app registration > Authentication > Redirect URIs', url: u('/api/account/channels/email/oauth/callback') },
        { id: 'microsoft-notify', label: 'New-mail notification address', where: 'Registered by Halo with each mailbox, and recreated by itself when this address changes', url: u('/api/email/webhook'), automatic: true },
      ],
    },
    {
      id: 'google',
      title: 'Gmail',
      items: [{ id: 'gmail-redirect', label: 'Sign-in redirect URI', where: 'Google Cloud > APIs & Services > Credentials > Authorized redirect URIs', url: u('/api/account/channels/gmail/oauth/callback') }],
    },
    {
      id: 'tiktok',
      title: 'TikTok',
      items: [{ id: 'tiktok-redirect', label: 'Sign-in redirect URI', where: 'TikTok developer app > Login Kit > Redirect URI', url: u('/api/account/channels/tiktok/oauth/callback') }],
    },
    {
      id: 'jira',
      title: 'Jira',
      items: [
        { id: 'jira-callback', label: 'OAuth callback URL', where: 'Atlassian developer console > OAuth 2.0 (3LO) > Callback URL (only one is allowed)', url: u('/api/integrations/jira/callback') },
      ],
    },
    {
      id: 'vircle-chat',
      title: 'Vircle Chat (the gateway)',
      items: [
        { id: 'vircle-chat-webhook', label: 'Halo webhook address', where: 'On the gateway server: node dist/cli.js update-workspace --key <workspace key> --halo-url <this address>', url: u('/api/vircle-chat/webhook') },
      ],
    },
    {
      id: 'widget',
      title: 'Web chat widget',
      items: [{ id: 'widget-loader', label: 'Widget script address', where: 'Every website that embeds the widget (the snippet in Settings > Channels > Web Widget already uses it)', url: u('/widget/loader.js') }],
    },
    {
      id: 'supabase',
      title: 'Supabase sign-in',
      items: [
        { id: 'supabase-site', label: 'Site URL', where: 'Supabase > Authentication > URL Configuration > Site URL', url: base },
        { id: 'supabase-redirect', label: 'Redirect URL pattern', where: 'Supabase > Authentication > URL Configuration > Redirect URLs', url: u('/**') },
      ],
    },
  ]
}

/** Host part of an address, lower-cased, for comparing the address in use with the canonical one. */
export function hostOf(address: string): string {
  try {
    return new URL(address).host.toLowerCase()
  } catch {
    return address.toLowerCase()
  }
}
