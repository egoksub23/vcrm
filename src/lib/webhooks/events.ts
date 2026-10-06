// ============================================================
// Outbound webhook event vocabulary — pure, no I/O.
//
// An endpoint subscribes to one or more of these. Adding an event is
// one entry here plus a `dispatchWebhookEvent` call at the source of
// the event (the DB stores subscriptions as a free `text[]`, so no
// migration is needed — same model as API scopes).
// ============================================================

export const WEBHOOK_EVENTS = [
  'message.received', // an inbound WhatsApp message landed
  'message.status_updated', // a sent message advanced (sent/delivered/read)
  'conversation.created', // a new conversation was opened for a contact
  // Doc Sign (emitted by src/lib/sign/service/outbound.ts; a workspace without Doc Sign never emits them)
  'sign.sent', // a document was sent for signing
  'sign.viewed', // a signer opened their link for the first time
  'sign.completed', // every signer signed and the sealed file is ready
  'sign.declined', // a signer declined
  'sign.expired', // a document passed its expiry date unsigned
  'sign.voided', // the sender cancelled a document
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Human-readable descriptions (surfaced in docs / a future UI). */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  'message.received': 'An inbound message was received from a contact',
  'message.status_updated':
    'A message you sent changed delivery status (sent/delivered/read/failed)',
  'conversation.created': 'A new conversation was opened',
  'sign.sent': 'A Doc Sign document was sent for signing',
  'sign.viewed': 'A signer opened their signing link for the first time',
  'sign.completed': 'Every signer signed: the sealed file is ready (carries its SHA-256 and the public verify page)',
  'sign.declined': 'A signer declined to sign',
  'sign.expired': 'A document passed its expiry date without being signed',
  'sign.voided': 'A document was cancelled by the sender',
};

/** Type-narrow an unknown value into a valid `WebhookEvent`. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Validate + de-duplicate a caller-supplied event list. Returns the
 * cleaned list, or `null` if any entry is unknown (callers turn that
 * into a 400). An empty list is rejected as `null` too — an endpoint
 * subscribed to nothing is almost certainly a mistake.
 */
export function normalizeEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const entry of input) {
    if (!isWebhookEvent(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
