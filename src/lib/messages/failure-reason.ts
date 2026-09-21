// ============================================================
// Why did this message not go out?
//
// Turns the raw failure Meta (WhatsApp Cloud API, Messenger and
// Instagram Send API) or a mail provider reported into a plain-English
// title plus "what to do". The raw code / title / details are kept
// alongside so the UI can still show them in an info popover.
//
// The same table serves both ways a send can fail:
//   - synchronously: the Graph call itself is rejected while the agent
//     clicks Send (see `sendMessageToConversation`), and
//   - asynchronously: Meta accepted it, then a `failed` status webhook
//     arrives with `errors[0]` (stored in messages.error_code /
//     error_title / error_details by migration 042).
//
// Pure: no I/O, no i18n runtime. The English text lives here so the API
// and logs have something readable; the inbox translates by `kind`
// (Inbox.failure.<kind>.title / .action), and a test keeps the two in
// step.
//
// Error codes:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
//   https://developers.facebook.com/docs/messenger-platform/reference/send-api
// ============================================================

export type FailureKind =
  | 'allowlist'
  | 'window_closed'
  | 'window_closed_social'
  | 'undeliverable'
  | 'auth'
  | 'rate_limit'
  | 'permission'
  | 'same_number'
  | 'temporary'
  | 'marketing_limit'
  | 'template'
  | 'media'
  | 'account_restricted'
  | 'recipient_unavailable'
  | 'invalid_request'
  | 'unknown'

/** What the provider told us, exactly as stored on the message row. */
export interface FailureInput {
  code?: number | null
  title?: string | null
  details?: string | null
  /** The message's channel, when known. Picks the wording for a closed
   *  window (WhatsApp offers a template; Messenger/Instagram do not). */
  channel?: string | null
}

export interface FailureReason {
  kind: FailureKind
  /** Plain-English headline. For `unknown` it carries Meta's own title and the code. */
  title: string
  /** What the person should do next. */
  action: string
  code: number | null
  rawTitle: string | null
  rawDetails: string | null
  /** A second attempt has a realistic chance of working without anyone fixing anything. */
  retryable: boolean
  /** The WhatsApp 24-hour window is closed: only a template can reopen the chat. */
  needsTemplate: boolean
}

export const FAILURE_TEXT: Record<Exclude<FailureKind, 'unknown'>, { title: string; action: string }> = {
  allowlist: {
    title: "This number is not on your WhatsApp test number's allowed list.",
    action: 'Add it in Meta, or use a production number.',
  },
  window_closed: {
    title: 'The 24-hour window has closed.',
    action: 'Send an approved template to start the conversation again.',
  },
  window_closed_social: {
    title: 'The messaging window for this customer has closed.',
    action: 'Wait for the customer to message you again, then reply.',
  },
  undeliverable: {
    title: 'WhatsApp could not deliver this message.',
    action:
      "The number may not be on WhatsApp, or the customer has not accepted WhatsApp's latest terms. Check the number and try again.",
  },
  auth: {
    title: 'The connection has expired.',
    action: 'Ask an admin to reconnect the channel in Settings, Channels.',
  },
  rate_limit: {
    title: 'Sending too fast.',
    action: 'Wait a moment and try again.',
  },
  permission: {
    title: 'This channel is missing a permission.',
    action: 'Ask an admin to check the app permissions in Meta, then reconnect the channel.',
  },
  same_number: {
    title: 'The recipient is the same as the sender.',
    action: "Check the contact's number. It cannot be your own business number.",
  },
  temporary: {
    title: "A temporary problem on the channel provider's side.",
    action: 'Try again in a minute.',
  },
  marketing_limit: {
    title: 'Meta limited marketing messages to this customer.',
    action: 'Wait before trying again, or send a utility template instead.',
  },
  template: {
    title: 'The template could not be sent.',
    action: 'Check the template name, language and parameters in Templates, then resend.',
  },
  media: {
    title: 'The attachment could not be sent.',
    action: 'Check the file type and size, then send it again.',
  },
  account_restricted: {
    title: 'The WhatsApp account has a restriction.',
    action: 'Ask an admin to check the account status and payment method in Meta.',
  },
  recipient_unavailable: {
    title: 'This customer cannot receive messages right now.',
    action: 'Try again later.',
  },
  invalid_request: {
    title: 'Meta rejected this message.',
    action: 'Check the content and try again.',
  },
}

export const UNKNOWN_FAILURE_TITLE = 'The message could not be sent.'
export const UNKNOWN_FAILURE_ACTION =
  'Try again. If it keeps failing, ask your admin and quote the code.'

/** Error code to kind. Codes are Meta's `error.code`. */
export const FAILURE_CODE_KIND: Readonly<Record<number, Exclude<FailureKind, 'unknown' | 'window_closed_social'>>> = {
  // Recipient not on the test number's allowed list.
  131030: 'allowlist',
  // 24-hour customer-service window closed (470 is the legacy code for it).
  131047: 'window_closed',
  470: 'window_closed',
  // Undeliverable: not on WhatsApp, or has not accepted the latest terms.
  131026: 'undeliverable',
  // Token / session problems.
  190: 'auth',
  463: 'auth',
  467: 'auth',
  102: 'auth',
  401: 'auth',
  // Throttling.
  4: 'rate_limit',
  17: 'rate_limit',
  32: 'rate_limit',
  613: 'rate_limit',
  80007: 'rate_limit',
  130429: 'rate_limit',
  131048: 'rate_limit',
  131056: 'rate_limit',
  // Permissions.
  3: 'permission',
  10: 'permission',
  200: 'permission',
  131005: 'permission',
  // Recipient equals sender.
  131021: 'same_number',
  // Transient provider trouble.
  1: 'temporary',
  2: 'temporary',
  131000: 'temporary',
  131016: 'temporary',
  131057: 'temporary',
  133004: 'temporary',
  133016: 'temporary',
  // "Healthy ecosystem" marketing cap.
  131049: 'marketing_limit',
  // Template problems.
  132000: 'template',
  132001: 'template',
  132005: 'template',
  132007: 'template',
  132012: 'template',
  132015: 'template',
  132016: 'template',
  132068: 'template',
  132069: 'template',
  // Media.
  131051: 'media',
  131052: 'media',
  131053: 'media',
  // Account state.
  368: 'account_restricted',
  131031: 'account_restricted',
  131037: 'account_restricted',
  131042: 'account_restricted',
  133010: 'account_restricted',
  // Messenger / Instagram: the person cannot be reached.
  551: 'recipient_unavailable',
  // Malformed request.
  100: 'invalid_request',
  131008: 'invalid_request',
  131009: 'invalid_request',
  131055: 'invalid_request',
}

const SOCIAL_CHANNELS = new Set(['messenger', 'instagram'])

/** Wording hints for when the code alone is missing or ambiguous (10 is both "permission" and "outside window"). */
function kindFromText(text: string): FailureKind | null {
  if (/not in (the )?allowed list/i.test(text)) return 'allowlist'
  if (/outside (of )?(the )?allowed window|24.?hour|re-?engagement|customer service window/i.test(text)) {
    return 'window_closed'
  }
  if (/access token|session (has )?expired|token (has )?expired|invalid_grant|unauthenticated/i.test(text)) {
    return 'auth'
  }
  if (/rate limit|too many (calls|requests|messages)|throttl/i.test(text)) return 'rate_limit'
  if (/isn.t available right now|not available right now/i.test(text)) return 'recipient_unavailable'
  return null
}

function cleanTitle(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.replace(/^\(#\d+\)\s*/, '').trim()
  return trimmed || null
}

/**
 * Explain a stored failure. Never throws; an unrecognised code falls
 * back to Meta's own title plus the code so nothing is hidden.
 */
export function explainFailure(input: FailureInput): FailureReason {
  const code = typeof input.code === 'number' ? input.code : null
  const rawTitle = cleanTitle(input.title)
  const rawDetails = input.details?.trim() || null
  const text = [rawTitle, rawDetails].filter(Boolean).join(' ')
  const social = input.channel ? SOCIAL_CHANNELS.has(input.channel) : false

  let kind: FailureKind = 'unknown'
  const byCode = code != null ? FAILURE_CODE_KIND[code] : undefined
  const byText = text ? kindFromText(text) : null

  if (byCode && byCode !== 'permission' && byCode !== 'invalid_request') {
    kind = byCode
  } else if (byText && (byCode === 'permission' || byCode === 'invalid_request' || byCode === undefined)) {
    // 10 / 200 / 100 are catch-alls: the wording tells us which problem it really is.
    kind = byText
  } else if (byCode) {
    kind = byCode
  }

  // Messenger / Instagram have no template to fall back on.
  if (kind === 'window_closed' && social) kind = 'window_closed_social'

  const retryable =
    kind === 'rate_limit' || kind === 'temporary' || kind === 'recipient_unavailable' || kind === 'unknown'
  const needsTemplate = kind === 'window_closed'

  if (kind === 'unknown') {
    const shown = rawTitle ?? UNKNOWN_FAILURE_TITLE
    return {
      kind,
      title: code != null ? `${shown} (code ${code})` : shown,
      action: UNKNOWN_FAILURE_ACTION,
      code,
      rawTitle,
      rawDetails,
      retryable,
      needsTemplate,
    }
  }

  const text2 = FAILURE_TEXT[kind]
  return {
    kind,
    title: text2.title,
    action: text2.action,
    code,
    rawTitle,
    rawDetails,
    retryable,
    needsTemplate,
  }
}

/** One line for logs and toasts: "title action". */
export function failureSummary(reason: Pick<FailureReason, 'title' | 'action'>): string {
  return `${reason.title} ${reason.action}`
}

// ------------------------------------------------------------
// Turning a thrown error into the three stored fields.
// ------------------------------------------------------------

export interface StoredFailure {
  code: number | null
  title: string
  details: string | null
}

const MAX_TITLE = 300
const MAX_DETAILS = 1000

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Read the provider's code / title / details out of whatever a send
 * threw. Structural on purpose: the WhatsApp, Meta and Graph error
 * classes are separate copies, and mail providers report their own
 * shapes. An auth failure from a mail provider is stored as code 401
 * so the same table maps it to "reconnect".
 */
export function failureFromError(err: unknown): StoredFailure {
  if (typeof err !== 'object' || err === null) {
    return { code: null, title: clip(String(err) || 'Unknown error', MAX_TITLE), details: null }
  }
  const e = err as {
    message?: unknown
    code?: unknown
    details?: unknown
    isAuthError?: unknown
    httpStatus?: unknown
  }
  const message = typeof e.message === 'string' && e.message ? e.message : 'Unknown error'
  const title = clip(cleanTitle(message) ?? message, MAX_TITLE)
  const details = typeof e.details === 'string' && e.details ? clip(e.details, MAX_DETAILS) : null

  if (typeof e.code === 'number') {
    return { code: e.code, title, details }
  }
  if (e.isAuthError === true) {
    return { code: 401, title, details }
  }
  return { code: null, title, details }
}
