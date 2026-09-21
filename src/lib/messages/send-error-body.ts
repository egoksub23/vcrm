import type { SendMessageError } from '@/lib/whatsapp/send-message'
import { explainFailure, failureSummary } from '@/lib/messages/failure-reason'

/**
 * The JSON the dashboard's send and resend routes return when a send is
 * rejected. `error` keeps its old meaning (a readable sentence); the extra
 * fields let the inbox point at the saved `failed` bubble and show the
 * friendly reason without a second request.
 */
export function sendErrorBody(err: SendMessageError, channel?: string | null) {
  const body: Record<string, unknown> = { error: err.message, code: err.code }
  if (err.failedMessageId) body.failed_message_id = err.failedMessageId
  if (err.failure) {
    const reason = explainFailure({ ...err.failure, channel })
    body.failure = {
      code: err.failure.code,
      title: err.failure.title,
      details: err.failure.details,
      kind: reason.kind,
      friendly: failureSummary(reason),
      needs_template: reason.needsTemplate,
    }
  }
  return body
}
