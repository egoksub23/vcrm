import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  SendMessageError,
  VALID_MESSAGE_TYPES,
} from '@/lib/whatsapp/send-message'
import { sendErrorBody } from '@/lib/messages/send-error-body'
import { loadWhatsappWindowOpen } from '@/lib/messages/window'
import { FAILURE_TEXT } from '@/lib/messages/failure-reason'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'

// Resend a message that did not go out (the red "Not sent" bubble).
//
// Steps: load the failed row, claim it (failed -> sending, one winner even
// on a double click), send the same content on the same channel through the
// shared send core (which saves a NEW row), then remove the old failed row
// so the chat shows one message, not two. If the resend fails again the same
// row goes back to `failed` with the new reason. Same capability as sending.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requireCapability('messages.send')

    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params

    const { data: row, error: rowError } = await supabase
      .from('messages')
      .select('*, conversation:conversations!inner(id, account_id)')
      .eq('id', id)
      .maybeSingle()

    const conversation = (row?.conversation ?? null) as { id: string; account_id: string } | null
    if (rowError || !row || !conversation || conversation.account_id !== accountId) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    if (row.is_internal || (row.sender_type !== 'agent' && row.sender_type !== 'bot')) {
      return NextResponse.json({ error: 'Only an outgoing message can be resent' }, { status: 400 })
    }
    if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(row.content_type)) {
      return NextResponse.json(
        { error: `A ${row.content_type} message cannot be resent` },
        { status: 400 },
      )
    }
    if (row.status === 'sending') {
      return NextResponse.json(
        { error: 'This message is already being resent', code: 'in_progress' },
        { status: 409 },
      )
    }
    if (row.status !== 'failed') {
      return NextResponse.json(
        { error: 'This message was not marked as failed', code: 'not_failed' },
        { status: 409 },
      )
    }

    // The 24-hour rule: on WhatsApp a template is the only thing that can
    // reopen a closed window, so do not retry blindly. Answer before claiming
    // the row, so it stays failed and the agent is pointed at Templates.
    if (row.channel_type === 'whatsapp' && row.content_type !== 'template') {
      const open = await loadWhatsappWindowOpen(supabase, conversation.id)
      if (!open) {
        return NextResponse.json(
          {
            error: `${FAILURE_TEXT.window_closed.title} ${FAILURE_TEXT.window_closed.action}`,
            code: 'window_closed',
            needs_template: true,
          },
          { status: 409 },
        )
      }
    }

    // Claim: only one request can move this row from failed to sending.
    const { data: claimed, error: claimError } = await supabase
      .from('messages')
      .update({ status: 'sending' })
      .eq('id', id)
      .eq('status', 'failed')
      .select('id')
    if (claimError) {
      console.error('[resend] could not claim the failed message:', claimError.message)
      return NextResponse.json({ error: 'Could not resend this message' }, { status: 500 })
    }
    if (!claimed || claimed.length === 0) {
      return NextResponse.json(
        { error: 'This message is already being resent', code: 'in_progress' },
        { status: 409 },
      )
    }

    const restoreFailed = async (
      failure?: { code: number | null; title: string; details: string | null } | null,
    ) => {
      const patch: Record<string, unknown> = { status: 'failed' }
      if (failure) {
        patch.error_code = failure.code
        patch.error_title = failure.title
        patch.error_details = failure.details
      }
      const { error } = await supabase
        .from('messages')
        .update(patch)
        .eq('id', id)
        .eq('status', 'sending')
      if (error) console.error('[resend] could not restore the failed state:', error.message)
    }

    const payload = (row.send_payload ?? {}) as {
      filename?: string
      template_language?: string
      template_params?: string[]
      template_message_params?: unknown
    }

    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId: conversation.id,
        messageType: row.content_type,
        contentText: row.content_text,
        contentHtml: row.content_html,
        mediaUrl: row.media_url,
        filename: payload.filename ?? null,
        templateName: row.template_name,
        templateLanguage: payload.template_language ?? null,
        templateParams: payload.template_params,
        templateMessageParams: payload.template_message_params,
        interactivePayload: (row.interactive_payload ?? null) as InteractiveMessagePayload | null,
        replyToMessageId: row.reply_to_message_id,
        channelOverride: row.channel_type,
        senderType: row.sender_type,
        aiGenerated: !!row.ai_generated,
        senderUserId: row.sender_type === 'agent' ? (row.sender_id ?? userId) : null,
        // This route owns the failed row: it is updated below, not duplicated.
        persistFailedAttempt: false,
      })

      // The new message is saved. Remove the failed one; if that is refused,
      // hide it through the same Move to Trash flag the inbox already uses.
      const { error: deleteError } = await supabase
        .from('messages')
        .delete()
        .eq('id', id)
        .eq('status', 'sending')
      if (deleteError) {
        console.error('[resend] could not remove the failed message:', deleteError.message)
        await supabase
          .from('messages')
          .update({
            status: 'failed',
            pending_delete: true,
            pending_delete_at: new Date().toISOString(),
          })
          .eq('id', id)
      }

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        replaced_message_id: id,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        await restoreFailed(err.failure)
        return NextResponse.json(
          { ...sendErrorBody(err, row.channel_type), failed_message_id: id },
          { status: err.status },
        )
      }
      await restoreFailed()
      throw err
    }
  } catch (error) {
    console.error('Error in message resend POST:', error)
    return toErrorResponse(error)
  }
}
