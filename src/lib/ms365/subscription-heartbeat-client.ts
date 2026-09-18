/**
 * Fire-and-forget ping to /api/email/subscription-heartbeat. Called
 * from the Inbox page and from opening an Email(MS365) conversation —
 * the route itself rate-limits to once per 24h per account, so this
 * is safe to call on every mount without thinking about it here.
 * Never surfaced to the UI: a network hiccup or a Graph failure here
 * just means the daily cron catches it instead.
 */
export function pingEmailSubscriptionHeartbeat(): void {
  fetch('/api/email/subscription-heartbeat', { method: 'POST' }).catch(() => {
    // Swallowed on purpose — see module doc above.
  });
}
