// ============================================================
// A gateway refusal, in the terms the rest of the send path already speaks.
//
// `failureFromError` (lib/messages/failure-reason.ts) keeps a numeric `code` and
// a `details` string, and `explainFailure` turns the code into the plain-English
// "what happened / what to do" the inbox shows. The gateway answers in its own
// string codes (contract section 4), so each is mapped to the closest existing
// kind and the gateway's own code and message are kept as the details.
// ============================================================

import { GatewayError } from './gateway'

/** gateway error code to the code `explainFailure` already knows */
const FAILURE_CODE: Record<string, number> = {
  unauthorized: 401, // the connection was refused: "reconnect"
  rate_limited: 4, // sending too fast
  unreachable: 2, // a temporary problem on the other side
  bad_response: 2,
  invalid_media: 131053, // the attachment could not be sent
  user_not_found: 551, // this customer cannot receive messages
  blocked: 551,
  message_too_long: 100, // the message was rejected
}

export class VircleSendError extends Error {
  readonly code: number
  readonly details: string
  constructor(source: GatewayError) {
    super(`Vircle Chat: ${source.message}`)
    this.name = 'VircleSendError'
    this.code = FAILURE_CODE[source.code] ?? (source.retryable ? 2 : 100)
    this.details = `${source.code}: ${source.message}`
  }
}
