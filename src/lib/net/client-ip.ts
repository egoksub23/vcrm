/**
 * The caller's IP address, for rate-limit keys.
 *
 * `X-Forwarded-For` is a list each proxy appends to, so its LEFT-most entry is
 * whatever the client chose to send. Taking it let anyone dodge a per-IP limit
 * by sending a different value on every request. The entries a trusted proxy
 * added are at the RIGHT, so we count from the right: with N trusted proxies in
 * front of the app, the client is the Nth entry from the end.
 *
 * Set `TRUSTED_PROXY_HOPS` to the number of reverse proxies in front of the app
 * (default 1: one proxy such as Caddy, nginx or a load balancer). Use 2 for
 * Cloudflare in front of a proxy. With 0 no forwarding header is believed and
 * every caller shares one bucket ("unknown"): only correct when the app is
 * exposed directly, where the header carries nothing we can trust.
 */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

export function clientIp(
  headers: Pick<Headers, 'get'>,
  hops: number = trustedProxyHops(),
): string {
  if (hops === 0) return 'unknown';
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Fewer entries than proxies means the header was not written by all of
  // them; the entry nearest the app is still the one our proxy appended.
  const fromProxy = entries[Math.max(entries.length - hops, 0)];
  return fromProxy || headers.get('x-real-ip')?.trim() || 'unknown';
}
