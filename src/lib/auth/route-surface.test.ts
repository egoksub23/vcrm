import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// ============================================================
// The HTTP surface, as an inventory.
//
// Two rules that stop a new route from quietly becoming an open door:
//
//  1. Every API route authenticates the caller in a way this file recognises
//     (session + capability, API key, operator, cron secret, a webhook signature,
//     a visitor token). A route with none of them must be listed in PUBLIC_ROUTES
//     with the reason it is safe, so a new one fails here until someone has looked.
//
//  2. A route that uses the service-role client (it bypasses row level security)
//     must refer to an account somewhere, otherwise nothing scopes what it
//     touches to one workspace. System-wide jobs and provider webhooks are the
//     reviewed exceptions in SYSTEM_ROUTES.
//
// Heuristic by design (it reads source, it does not run anything), so it
// catches the careless case, not a determined mistake. The database-side
// guarantees live in supabase/ci/verify-*.sql.
// ============================================================

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api')

const AUTH_MARKER = new RegExp(
  [
    'requireCapability', 'requireAnyCapability', 'requireApiKey', 'requirePlatformAdmin',
    'getCurrentAccount', 'requireAdmin', 'auth\\.getUser', 'getUser\\(', 'cronRoute',
    'checkCronSecret', 'Signature', 'verifyVisitorJwt', 'requireUser', 'requireSession',
    // Doc Sign's staff() wrapper (lib/sign/http.ts): requireCapability, then a rate limit
    'staff\\(',
  ].join('|'),
)
const ADMIN_CLIENT = /supabaseAdmin|createAdminClient|SUPABASE_SERVICE_ROLE_KEY|admin-client|supabase\/admin/
const ACCOUNT_REFERENCE = new RegExp(
  [
    'accountId', 'account_id', 'requireApiKey', 'requirePlatformAdmin', 'getCurrentAccount',
    'requireCapability', 'requireAnyCapability', 'requireAdmin',
  ].join('|'),
)

/** Reachable without a session or key. Why each is safe. */
const PUBLIC_ROUTES: Record<string, string> = {
  'account/channels/email/oauth/callback': 'OAuth redirect; signed one-time state ties it to the workspace and user that started it',
  'account/channels/gmail/oauth/callback': 'OAuth redirect; one-time state bound to the signed-in person who started it',
  'account/channels/instagram/oauth/callback': 'OAuth redirect; one-time state bound to the signed-in person who started it',
  'account/channels/messenger/oauth/callback': 'OAuth redirect; one-time state bound to the signed-in person who started it',
  'account/channels/tiktok/oauth/callback': 'OAuth redirect; one-time state row bound to the signed-in person who started it',
  'account/transfer-ownership': 'session user via the transfer_account_ownership RPC, which checks the caller itself',
  'account/export': 'owner only (requireRole owner), a full export of the workspace',
  'account/support-access/[id]': 'owner only (requireRole owner), through support_revoke_access, which checks the caller itself',
  'account/deletion': 'owner only (requireRole owner), through the workspace_deletion_* RPCs, which check the caller themselves',
  'email/webhook': 'Microsoft Graph notification; per-mailbox client state compared before anything is read',
  'gmail/webhook': 'Pub/Sub push; per-mailbox token compared in constant time',
  'invitations/[token]/peek': 'invite preview by secret token; rate limited per caller address',
  'whatsapp/webhook': 'Meta delivery; HMAC signature bound to the workspace (lib/whatsapp/webhook-signature.ts)',
  'widget/media-url': 'web chat visitor; visitor JWT; signs only a file named by a message of the visitor\'s own conversation, inside the workspace folder',
  'widget/message': 'web chat visitor; bearer visitor JWT verified in lib/widget/visitor-auth.ts, same-account checks',
  'widget/receipt': 'web chat visitor; visitor JWT',
  'widget/upload-url': 'web chat visitor; visitor JWT',
  'sign/public/[token]': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404',
  'sign/public/[token]/code': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404; sends a code to the address the document went to, five an hour',
  'sign/public/[token]/code/verify': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404; every try counted in the database, five tries per code, signed session cookie on success',
  'sign/public/[token]/consent': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404',
  'sign/public/[token]/answers': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404',
  'sign/public/[token]/complete': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404',
  'sign/public/[token]/decline': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404',
  'sign/public/[token]/file': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404; shows only the document as sent, or the sealed copy once complete, and only after the code when one is required',
  'sign/public/[token]/upload': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404; a signer\'s own file for a field of their own part only: the kind is decided from the bytes, the field\'s limits and 50 MB per document apply, the code is required when the document asks for one, and the storage path never leaves the server',
  'sign/public/[token]/review': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404; read only: the answers as they will be printed, after the code when one is required, and only once the signer\'s own parts are complete',
  'sign/public/[token]/forward': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address and per signer position (six an hour, shared), a workspace with Doc Sign off answers 404; hands the signer\'s own turn, or one part of their own form, to a name and an email only when the sender switched forwarding on for the document: at most two per position, never to the forwarder\'s own address or to someone already on the document for the role, a delegate cannot pass a part on, the new person gets a link of their own (the old one dies at once) and agrees for themselves, every forward is an audit event with a masked address and never a link, and the code is required when the document asks for one',
  'sign/public/[token]/envelope/finish': 'the link a signer is sent: a random token whose SHA-256 is looked up (publicLink in lib/sign/http.ts), a rate limit per caller address, a workspace with Doc Sign off answers 404; only for an envelope link, and only the documents of the person whose link it is (their own rows, found through the link, never another document or person), completed in order through the same rules as a document alone, the code required when the documents ask for one',
  'sign/register/[slug]': 'a public registration page (/r/<slug>): the slug is a random, unguessable identifier and an unknown, switched-off or Doc Sign-off form all answer the same 404; limits per address and per form (shared, address kept as a keyed hash), a hidden field, a signed form token that must be genuine, unexpired and at least three seconds old, optional Turnstile, strict validation, a daily cap per form, and one open document per email per form per day; it creates or fills a contact (by email only, never overwriting) and sends the document only to the email typed, never returning a link, and every outcome is a sign_registrations row',
}

/** Use the service-role client with no account in scope: jobs over every workspace, provider webhooks. */
const SYSTEM_ROUTES: Record<string, { why: string; mustContain: string }> = {
  'incidents/escalation-cron': { why: 'system-wide job', mustContain: 'cronRoute' },
  'messages/sweep-cron': { why: 'system-wide job', mustContain: 'cronRoute' },
  'usage/snapshot-cron': { why: 'system-wide job', mustContain: 'cronRoute' },
  'platform/deletion-cron': { why: 'system-wide job', mustContain: 'cronRoute' },
  'sla/tickets-cron': { why: 'system-wide job', mustContain: 'cronRoute' },
  'sign/jobs-cron': { why: 'system-wide job (seal, expire, remind, across workspaces)', mustContain: 'cronRoute' },
  'tiktok/webhook': { why: 'provider webhook, matched to a workspace by the connected account id', mustContain: 'verifyTikTokSignature' },
}

function routeFiles(dir: string = API_ROOT): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === 'route.ts') {
      out.push({
        id: path.relative(API_ROOT, path.dirname(full)).split(path.sep).join('/'),
        text: fs.readFileSync(full, 'utf8'),
      })
    }
  }
  return out
}

const routes = routeFiles()

describe('API route surface', () => {
  it('finds the routes (guards against the scan silently matching nothing)', () => {
    expect(routes.length).toBeGreaterThan(150)
  })

  it('every route authenticates the caller, or is a reviewed public route', () => {
    const unreviewed = routes.filter((r) => !AUTH_MARKER.test(r.text) && !(r.id in PUBLIC_ROUTES)).map((r) => r.id)
    expect(unreviewed, `Routes with no recognised authentication. If one is meant to be public, add it to PUBLIC_ROUTES with the reason; otherwise authenticate it:`).toEqual([])
  })

  it('every reviewed public route still exists and still has no other auth (so the list stays honest)', () => {
    const byId = new Map(routes.map((r) => [r.id, r]))
    const stale = Object.keys(PUBLIC_ROUTES).filter((id) => !byId.has(id) || AUTH_MARKER.test(byId.get(id)!.text))
    expect(stale, 'Remove these from PUBLIC_ROUTES: they are gone, or now authenticate and no longer need the exception').toEqual([])
  })

  it('a route using the service-role client scopes to an account, or is a reviewed system route', () => {
    const unscoped = routes
      .filter((r) => ADMIN_CLIENT.test(r.text) && !ACCOUNT_REFERENCE.test(r.text) && !(r.id in SYSTEM_ROUTES))
      .map((r) => r.id)
    expect(unscoped, 'Service-role routes that never mention an account. Scope them, or add to SYSTEM_ROUTES with the reason:').toEqual([])
  })

  it('system routes still exist, still need no account, and keep their own guard', () => {
    const byId = new Map(routes.map((r) => [r.id, r]))
    for (const [id, { mustContain }] of Object.entries(SYSTEM_ROUTES)) {
      const route = byId.get(id)
      expect(route, `${id} no longer exists: remove it from SYSTEM_ROUTES`).toBeTruthy()
      expect(route!.text, `${id} lost its guard (${mustContain})`).toContain(mustContain)
      expect(ACCOUNT_REFERENCE.test(route!.text), `${id} now refers to an account: remove it from SYSTEM_ROUTES`).toBe(false)
    }
  })
})
