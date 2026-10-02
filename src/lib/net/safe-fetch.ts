// ============================================================
// Outbound fetch that cannot be steered at the internal network.
//
// `isDeliverableUrl` (lib/webhooks/ssrf.ts) resolves a host and refuses
// private addresses, but it resolves once and the real request resolves
// again: a hostname whose DNS answers a public address to the check and a
// private one to the connection (DNS rebinding) walks straight past it,
// and a name checked at save time can be repointed afterwards.
//
// `pinnedFetch` closes that by checking the address the socket is really
// about to use. The dispatcher's connect step resolves the name through
// `guardedLookup`, which refuses any private, loopback, link-local or
// otherwise non-public answer, so there is no second lookup to flip. A
// literal IP in the URL never reaches a lookup, so it is checked up front.
//
// Redirects are NOT followed unless the caller says so: a 3xx to an
// internal address is the other classic way in. Callers that follow
// redirects themselves (web page import) re-check every hop.
// ============================================================

import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

import { isPrivateOrReservedIp } from '@/lib/webhooks/ssrf'

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void

type Resolver = (
  hostname: string,
  options: LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void

export class BlockedAddressError extends Error {
  readonly code = 'ESSRF_BLOCKED'
  constructor(host: string) {
    super(`Refusing to connect to a non-public address (${host})`)
    this.name = 'BlockedAddressError'
  }
}

/**
 * A `dns.lookup` replacement for `net.connect`: resolves normally, then
 * fails the connection if ANY answer is not publicly routable. (All, not
 * just the first: the socket may try any of them.)
 */
export function makeGuardedLookup(resolve: Resolver = dnsLookup as unknown as Resolver) {
  return function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err)
      if (!addresses || addresses.length === 0) {
        return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException)
      }
      if (addresses.some((a) => isPrivateOrReservedIp(a.address))) {
        return callback(new BlockedAddressError(hostname) as unknown as NodeJS.ErrnoException)
      }
      if (options.all) return callback(null, addresses)
      callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

let agent: Agent | undefined

function guardedAgent(): Agent {
  agent ??= new Agent({ connect: { lookup: makeGuardedLookup() as never } })
  return agent
}

/** Throws for a URL whose host is a literal private IP or an obviously internal name. */
function assertHostLiteral(rawUrl: string): void {
  const url = new URL(rawUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) throw new BlockedAddressError(host)
    return
  }
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new BlockedAddressError(host)
  }
}

/**
 * `fetch` through a connection that re-checks the resolved address. Same
 * arguments and result as `fetch`; `redirect` defaults to `'manual'`.
 *
 * It uses undici's own `fetch` with undici's own `Agent` rather than the
 * runtime's global `fetch`: the global one ships a different undici
 * version per Node release (this app builds on Node 20), and handing it
 * another version's dispatcher is not a supported pairing.
 */
export function pinnedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    assertHostLiteral(url)
  } catch (err) {
    return Promise.reject(err)
  }
  return undiciFetch(url, {
    redirect: 'manual',
    ...init,
    dispatcher: guardedAgent(),
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
}
