// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import type { ChannelType, MessageTemplate } from '@/types';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';
import { sendMessengerText, sendMessengerMedia, type MessengerMediaKind } from '@/lib/messenger/meta-api';
import { sendInstagramText, sendInstagramMedia, type InstagramMediaKind } from '@/lib/instagram/meta-api';
import { MetaApiError } from '@/lib/meta/errors';
import { getValidAccessToken } from '@/lib/ms365/token';
import { sendNewMail, sendReplyText, sendReplyWithAttachment, sendReplyHtml } from '@/lib/ms365/mail-api';
import { GraphApiError } from '@/lib/ms365/errors';
import { getValidAccessToken as getValidGmailAccessToken } from '@/lib/gmail/token';
import {
  sendNewMail as sendNewGmail,
  sendReply as sendGmailReply,
  getThreadingInfo as getGmailThreadingInfo,
} from '@/lib/gmail/gmail-api';
import { GmailApiError } from '@/lib/gmail/errors';
import { failureFromError, type StoredFailure } from '@/lib/messages/failure-reason';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  /** The provider's reason (code / title / details) when the failure came
   *  back from the channel itself — not set for validation or config errors. */
  readonly failure: StoredFailure | null;
  /** Our `messages.id` of the `failed` row saved for this attempt, so the
   *  caller can point the agent at it. Null when nothing was persisted. */
  readonly failedMessageId: string | null;
  constructor(
    code: string,
    message: string,
    status: number,
    extra?: { failure?: StoredFailure | null; failedMessageId?: string | null }
  ) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
    this.failure = extra?.failure ?? null;
    this.failedMessageId = extra?.failedMessageId ?? null;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  /** Rich-text body from the WYSIWYG composer (Email(MS365)/Gmail only)
   *  — quoted history already appended client-side. When set, the
   *  email/gmail branches send this as the message's real HTML body
   *  (so the recipient's own mail client renders it formatted) and
   *  persist it as `content_html` on our own copy of the message.
   *  `contentText` stays required as the plain-text fallback both the
   *  wire format and every non-email channel need. */
  contentHtml?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  /** Explicit channel pick for a conversation that spans more than one
   *  channel (migration 048's merge-by-contact) — the dashboard
   *  composer's channel selector sends this when the agent picks a
   *  channel other than the conversation's `last_channel_type` rollup.
   *  Falls back to `last_channel_type` when unset, which is every
   *  caller except the composer (automation engine, AI auto-reply,
   *  the public API). Not separately validated here — sending on a
   *  channel the contact has no identity for (e.g. Instagram without
   *  an igsid) already 400s via that channel's own branch below, the
   *  same failure mode as an invalid `last_channel_type`. */
  channelOverride?: ChannelType | null;
  /** Who's actually sending — the dashboard composer and the public API
   *  never pass this (default 'agent'); the automation engine's
   *  send_message step and the AI auto-reply bot pass 'bot' so the
   *  inbox renders it correctly and it's excluded from a human agent's
   *  own reply-time metrics. */
  senderType?: 'agent' | 'bot';
  /** Marks the persisted row `ai_generated = true` (badges it in the
   *  inbox). Only the AI auto-reply bot sets this. */
  aiGenerated?: boolean;
  /** Which teammate sent this — persisted onto the existing
   *  `messages.sender_id` column (migration 001; previously only ever
   *  populated for internal comments, see comment-write.ts). Only
   *  meaningful when `senderType` is 'agent'; leave unset for bot/
   *  automation sends so per-agent reports (Leaderboard, Users) don't
   *  attribute bot volume to a human. The dashboard composer passes the
   *  signed-in user; nothing else does. */
  senderUserId?: string | null;
  /** When the channel itself rejects the send, save the message as a
   *  `failed` row (with the reason) so it shows in the chat and can be
   *  resent. Default true. The resend route turns it off: it already owns
   *  the failed row and updates that one instead of adding a second. */
  persistFailedAttempt?: boolean;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } =
    params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    contentHtml,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
    channelOverride = null,
    senderType = 'agent',
    aiGenerated = false,
    senderUserId = null,
    persistFailedAttempt = true,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;

  // A merged conversation (migration 048) may have messages on any
  // channel; an agent's reply defaults to whichever channel the
  // customer most recently used (the last_channel_type rollup), unless
  // the composer's channel selector explicitly picked a different one
  // this conversation has also used.
  const channel = (channelOverride ?? conversation.last_channel_type) as ChannelType;

  // Web-widget conversations never go anywhere near Meta — persisting
  // the `messages` row *is* the delivery (the widget's own Realtime
  // subscription picks it up). Text and media (image / video / audio /
  // document) are delivered that way; templates and interactive messages
  // are Meta concepts with no widget equivalent, so they stay blocked (this
  // function is also the automation engine's send path, hence the
  // server-side guard). The visitor's widget confirms delivery / reading
  // through POST /api/widget/receipt.
  const isWidgetConversation = channel === 'web_widget';
  if (isWidgetConversation && messageType !== 'text' && !isMediaKind) {
    throw new SendMessageError(
      'bad_request',
      'Only text and media messages are supported on the web-chat channel',
      400
    );
  }

  // Messenger/Instagram/Email/Gmail support text + media, but none of
  // them have anything resembling WhatsApp's pre-approved HSM template
  // system or its interactive buttons/lists (see the automation
  // engine's assertWhatsappChannel for the same scope decision on the
  // automation-step side).
  const isMessengerConversation = channel === 'messenger';
  const isInstagramConversation = channel === 'instagram';
  const isEmailConversation = channel === 'email';
  const isGmailConversation = channel === 'gmail';
  if (
    (isMessengerConversation || isInstagramConversation || isEmailConversation || isGmailConversation) &&
    messageType !== 'text' &&
    !isMediaKind
  ) {
    throw new SendMessageError(
      'bad_request',
      'Only text and media messages are supported on this channel',
      400
    );
  }

  // A contact is addressable by phone number OR by business-scoped user
  // ID. Meta withholds the phone number for a customer who has adopted
  // a WhatsApp username, so those contacts carry only a BSUID and are
  // reached through Meta's `recipient` field instead of `to` (issue
  // #519). Phone stays preferred when we have one: only it supports the
  // trunk-prefix variant retry below. WhatsApp-only — the other
  // channels resolve their own send target below.
  let sendTarget = '';
  let hasValidPhone = false;
  let sanitizedPhone = '';
  if (channel === 'whatsapp') {
    const resolvedTarget = resolveContactSendTarget(contact);
    if (!resolvedTarget) {
      throw new SendMessageError(
        'bad_request',
        contact?.phone
          ? 'Invalid phone number format'
          : 'Contact has no phone number or WhatsApp user ID',
        400
      );
    }
    sendTarget = resolvedTarget.target;
    hasValidPhone = resolvedTarget.isPhone;
    sanitizedPhone = hasValidPhone ? sendTarget : '';
  }

  // WhatsApp config, account-scoped. Not needed at all for a widget send.
  let config: { id: string; phone_number_id: string; access_token: string } | null = null;
  let accessToken = '';
  if (channel === 'whatsapp') {
    const { data: configRow, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configError || !configRow) {
      throw new SendMessageError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        400
      );
    }
    config = configRow;
    accessToken = decrypt(configRow.access_token);

    // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
    if (isLegacyFormat(configRow.access_token)) {
      void db
        .from('whatsapp_config')
        .update({ access_token: encrypt(accessToken) })
        .eq('id', configRow.id)
        .then(({ error }: { error: { message: string } | null }) => {
          if (error) {
            console.warn(
              '[send-message] access_token GCM upgrade failed:',
              error.message
            );
          }
        });
    }
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row — needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
  }

  // What we store for this message — the same row whether the send goes
  // through (status 'sent') or the channel rejects it (status 'failed').
  //
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble — issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  // What a resend needs that the columns above do not carry: the template
  // language and parameters, and a document's file name. Only stored when
  // there is something to store, so a plain text send never depends on the
  // column (migration 094) existing yet.
  const sendPayload: Record<string, unknown> = {};
  if (messageType === 'template') {
    if (templateLanguage) sendPayload.template_language = templateLanguage;
    if (templateParams && templateParams.length) sendPayload.template_params = templateParams;
    if (templateMessageParams) sendPayload.template_message_params = templateMessageParams;
  }
  if (filename) sendPayload.filename = filename;

  const baseRow: Record<string, unknown> = {
    conversation_id: conversationId,
    sender_type: senderType,
    sender_id: senderType === 'agent' ? senderUserId : null,
    content_type: messageType,
    content_text: persistedText,
    // Only ever set for Email(MS365)/Gmail sends from the WYSIWYG
    // composer; every other channel/caller leaves this null, and
    // MessageBubble only renders the rich view when it's present.
    content_html: contentHtml || null,
    media_url: mediaUrl || null,
    template_name: templateName || null,
    interactive_payload:
      messageType === 'interactive' ? interactivePayload : null,
    channel_type: channel,
    ai_generated: aiGenerated,
    reply_to_message_id: replyToMessageId || null,
    ...(Object.keys(sendPayload).length ? { send_payload: sendPayload } : {}),
  };

  // Insert a `messages` row. If the database has not had migration 094 yet,
  // retry without `send_payload` rather than losing the message.
  const insertMessageRow = async (row: Record<string, unknown>) => {
    const first = await db.from('messages').insert(row).select().single();
    if (
      first.error &&
      'send_payload' in row &&
      /send_payload/i.test(first.error.message ?? '')
    ) {
      const { send_payload: _dropped, ...rest } = row;
      void _dropped;
      return db.from('messages').insert(rest).select().single();
    }
    return first;
  };

  // The channel rejected the send. Save what the agent tried to send as a
  // `failed` bubble carrying the reason, so it stays in the chat and can be
  // resent, then raise the error the caller already expected. Nothing here
  // touches the conversation's preview, unread count or awaiting-response
  // flag: a message that did not go out must not read as a reply.
  const failSend = async (
    cause: unknown,
    message: string
  ): Promise<never> => {
    const failure = failureFromError(cause);
    let failedMessageId: string | null = null;
    if (persistFailedAttempt) {
      try {
        const { data: failedRow, error: failedErr } = await insertMessageRow({
          ...baseRow,
          message_id: null,
          status: 'failed',
          error_code: failure.code,
          error_title: failure.title,
          error_details: failure.details,
        });
        if (failedErr) {
          console.error('[send-message] could not save the failed message:', failedErr.message);
        } else {
          failedMessageId = (failedRow as { id: string } | null)?.id ?? null;
        }
      } catch (saveErr) {
        console.error(
          '[send-message] could not save the failed message:',
          saveErr instanceof Error ? saveErr.message : saveErr
        );
      }
    }
    throw new SendMessageError('meta_error', message, 502, {
      failure,
      failedMessageId,
    });
  };

  // Send via Meta — retry across phone-number variants if Meta rejects
  // with "recipient not in allowed list"; persist a working variant
  // back to the contact so the next send goes straight through. Skipped
  // entirely for a widget conversation: there's no Meta call, and
  // `waMessageId` simply stays '' (the messages row has no Meta wamid).
  let waMessageId = '';
  let workingPhone = sendTarget;
  if (channel === 'whatsapp') {
    const cfg = config!;

    const attempt = async (phone: string): Promise<string> => {
      if (messageType === 'template') {
        const result = await sendTemplateMessage({
          phoneNumberId: cfg.phone_number_id,
          accessToken,
          to: phone,
          templateName: templateName!,
          language: sendLanguage,
          template: templateRow ?? undefined,
          messageParams: templateMessageParams ?? undefined,
          params: templateParams || [],
          contextMessageId,
        });
        return result.messageId;
      }
      if (isMediaKind) {
        const result = await sendMediaMessage({
          phoneNumberId: cfg.phone_number_id,
          accessToken,
          to: phone,
          kind: messageType as MediaKind,
          link: mediaUrl!,
          caption: contentText || undefined,
          filename: filename || undefined,
          contextMessageId,
        });
        return result.messageId;
      }
      if (messageType === 'interactive') {
        const p = interactivePayload!;
        if (p.kind === 'buttons') {
          const result = await sendInteractiveButtons({
            phoneNumberId: cfg.phone_number_id,
            accessToken,
            to: phone,
            bodyText: p.body,
            headerText: p.header || undefined,
            footerText: p.footer || undefined,
            buttons: p.buttons,
            contextMessageId,
          });
          return result.messageId;
        }
        const result = await sendInteractiveList({
          phoneNumberId: cfg.phone_number_id,
          accessToken,
          to: phone,
          bodyText: p.body,
          buttonLabel: p.button_label,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          sections: p.sections,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendTextMessage({
        phoneNumberId: cfg.phone_number_id,
        accessToken,
        to: phone,
        text: contentText!,
        contextMessageId,
      });
      return result.messageId;
    };

    try {
      // Variants only make sense for a phone number — a BSUID is opaque
      // and has exactly one correct form, so it gets a single attempt.
      const variants = hasValidPhone ? phoneVariants(sanitizedPhone) : [sendTarget];
      let lastError: unknown = null;

      for (const variant of variants) {
        try {
          waMessageId = await attempt(variant);
          workingPhone = variant;
          lastError = null;
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!isRecipientNotAllowedError(message)) {
            throw err;
          }
          lastError = err;
          console.warn(
            `[send-message] variant "${variant}" rejected by Meta, trying next…`
          );
        }
      }

      if (lastError) throw lastError;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error('[send-message] Meta send failed for all variants:', message);
      return failSend(err, `Meta API error: ${message}`);
    }

    if (hasValidPhone && workingPhone !== sanitizedPhone) {
      console.log(
        `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
      );
      await db
        .from('contacts')
        .update({ phone: workingPhone })
        .eq('id', contact.id);
    }
  }

  // Messenger send — real Graph API call (unlike the widget's no-op
  // branch above), via the account's connected Page.
  if (isMessengerConversation) {
    if (!contact.messenger_psid) {
      throw new SendMessageError('bad_request', 'Contact has no Messenger identity', 400);
    }
    const { data: cfg, error: cfgError } = await db
      .from('messenger_config')
      .select('id, page_id, page_access_token')
      .eq('account_id', accountId)
      .single();
    if (cfgError || !cfg) {
      throw new SendMessageError(
        'messenger_not_configured',
        'Messenger is not connected. Connect it in Settings → Channels first.',
        400
      );
    }
    const pageAccessToken = decrypt(cfg.page_access_token);
    try {
      const result = isMediaKind
        ? await sendMessengerMedia({
            pageId: cfg.page_id,
            pageAccessToken,
            recipientPsid: contact.messenger_psid,
            kind: (messageType === 'document' ? 'file' : messageType) as MessengerMediaKind,
            url: mediaUrl!,
          })
        : await sendMessengerText({
            pageId: cfg.page_id,
            pageAccessToken,
            recipientPsid: contact.messenger_psid,
            text: contentText!,
          });
      waMessageId = result.messageId;
    } catch (err) {
      if (err instanceof MetaApiError && err.code === 190) {
        await db.from('messenger_config').update({ needs_reauth: true }).eq('id', cfg.id);
      }
      const message = err instanceof Error ? err.message : 'Unknown Messenger API error';
      console.error('[send-message] Messenger send failed:', message);
      return failSend(err, `Messenger API error: ${message}`);
    }
  }

  // Instagram DM send — same shape as Messenger, scoped to the linked
  // IG business account instead of the Page.
  if (isInstagramConversation) {
    if (!contact.instagram_igsid) {
      throw new SendMessageError('bad_request', 'Contact has no Instagram identity', 400);
    }
    const { data: cfg, error: cfgError } = await db
      .from('instagram_config')
      .select('id, ig_business_account_id, page_access_token')
      .eq('account_id', accountId)
      .single();
    if (cfgError || !cfg) {
      throw new SendMessageError(
        'instagram_not_configured',
        'Instagram is not connected. Connect it in Settings → Channels first.',
        400
      );
    }
    const pageAccessToken = decrypt(cfg.page_access_token);
    try {
      const result = isMediaKind
        ? await sendInstagramMedia({
            igBusinessAccountId: cfg.ig_business_account_id,
            pageAccessToken,
            recipientIgsid: contact.instagram_igsid,
            kind: (messageType === 'document' ? 'file' : messageType) as InstagramMediaKind,
            url: mediaUrl!,
          })
        : await sendInstagramText({
            igBusinessAccountId: cfg.ig_business_account_id,
            pageAccessToken,
            recipientIgsid: contact.instagram_igsid,
            text: contentText!,
          });
      waMessageId = result.messageId;
    } catch (err) {
      if (err instanceof MetaApiError && err.code === 190) {
        await db.from('instagram_config').update({ needs_reauth: true }).eq('id', cfg.id);
      }
      const message = err instanceof Error ? err.message : 'Unknown Instagram API error';
      console.error('[send-message] Instagram send failed:', message);
      return failSend(err, `Instagram API error: ${message}`);
    }
  }

  // Email send — via the connected Microsoft 365 mailbox. Threads as a
  // real reply (POST /messages/{id}/reply) when there's a prior inbound
  // message from this contact to reply to; otherwise a fresh
  // POST /me/sendMail, same "first outbound has nothing to reply to"
  // case Messenger/Instagram don't have (every send there targets an
  // opaque PSID/IGSID, not an address a mail client would thread on).
  if (isEmailConversation) {
    if (!contact.email) {
      throw new SendMessageError('bad_request', 'Contact has no email address', 400);
    }
    const { data: cfg, error: cfgError } = await db
      .from('email_config')
      .select('*')
      .eq('account_id', accountId)
      .single();
    if (cfgError || !cfg) {
      throw new SendMessageError(
        'email_not_configured',
        'Email is not connected. Connect it in Settings → Channels first.',
        400
      );
    }
    try {
      const accessToken = await getValidAccessToken(cfg);

      const { data: lastInbound } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .eq('channel_type', 'email')
        .not('message_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const replyToMessageId = lastInbound?.message_id as string | undefined;

      let attachment: { name: string; contentType: string; contentBytesBase64: string } | undefined;
      if (isMediaKind) {
        const mediaResponse = await fetch(mediaUrl!);
        if (!mediaResponse.ok) {
          throw new Error(`Failed to fetch media for email attachment: ${mediaResponse.status}`);
        }
        const bytes = Buffer.from(await mediaResponse.arrayBuffer());
        attachment = {
          name: filename || mediaUrl!.split('/').pop() || 'attachment',
          contentType: mediaResponse.headers.get('content-type') || 'application/octet-stream',
          contentBytesBase64: bytes.toString('base64'),
        };
      }

      const text = contentText || '';
      if (replyToMessageId) {
        if (contentHtml) {
          await sendReplyHtml({ accessToken, replyToMessageId, html: contentHtml, attachment });
        } else if (attachment) {
          await sendReplyWithAttachment({ accessToken, replyToMessageId, text, attachment });
        } else {
          await sendReplyText({ accessToken, replyToMessageId, text });
        }
      } else {
        await sendNewMail({
          accessToken,
          toAddress: contact.email,
          subject: 'New message',
          text,
          html: contentHtml || undefined,
          attachment,
        });
      }
      // Graph's send/reply actions return no message id — there's no
      // async delivery-status webhook for this channel either, so
      // there's nothing to persist here. Same NULL convention as a
      // widget send (see the message_id comment below).
    } catch (err) {
      if (err instanceof GraphApiError && err.isAuthError) {
        await db.from('email_config').update({ needs_reauth: true }).eq('id', cfg.id);
      }
      const message = err instanceof Error ? err.message : 'Unknown Microsoft Graph error';
      console.error('[send-message] Email send failed:', message);
      return failSend(err, `Email send error: ${message}`);
    }
  }

  // Gmail send — same reply-vs-fresh-send split as the Microsoft 365
  // branch above, but Gmail's threading needs an extra lookup: the
  // RFC822 Message-ID header and Gmail's own threadId aren't the same
  // as the `message_id` we persist (Gmail's internal message id), so
  // getThreadingInfo fetches them fresh right before replying rather
  // than caching them on the messages row.
  if (isGmailConversation) {
    if (!contact.email) {
      throw new SendMessageError('bad_request', 'Contact has no email address', 400);
    }
    const { data: cfg, error: cfgError } = await db
      .from('gmail_config')
      .select('*')
      .eq('account_id', accountId)
      .single();
    if (cfgError || !cfg) {
      throw new SendMessageError(
        'gmail_not_configured',
        'Gmail is not connected. Connect it in Settings → Channels first.',
        400
      );
    }
    try {
      const accessToken = await getValidGmailAccessToken(cfg);

      const { data: lastInbound } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .eq('channel_type', 'gmail')
        .not('message_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const replyToMessageId = lastInbound?.message_id as string | undefined;

      let attachment: { name: string; contentType: string; contentBytesBase64: string } | undefined;
      if (isMediaKind) {
        const mediaResponse = await fetch(mediaUrl!);
        if (!mediaResponse.ok) {
          throw new Error(`Failed to fetch media for Gmail attachment: ${mediaResponse.status}`);
        }
        const bytes = Buffer.from(await mediaResponse.arrayBuffer());
        attachment = {
          name: filename || mediaUrl!.split('/').pop() || 'attachment',
          contentType: mediaResponse.headers.get('content-type') || 'application/octet-stream',
          contentBytesBase64: bytes.toString('base64'),
        };
      }

      const text = contentText || '';
      if (replyToMessageId) {
        const threading = await getGmailThreadingInfo({ accessToken, messageId: replyToMessageId });
        const subject = threading.subject
          ? /^re:/i.test(threading.subject)
            ? threading.subject
            : `Re: ${threading.subject}`
          : 'Re: your message';
        await sendGmailReply({
          accessToken,
          threadId: threading.threadId,
          inReplyToMessageId: threading.rfc822MessageId,
          toAddress: contact.email,
          subject,
          text,
          html: contentHtml || undefined,
          attachment,
        });
      } else {
        await sendNewGmail({
          accessToken,
          toAddress: contact.email,
          subject: 'New message',
          text,
          html: contentHtml || undefined,
          attachment,
        });
      }
      // Gmail's send response has no async delivery-status webhook to
      // correlate against, same as every other non-WhatsApp channel —
      // nothing to persist here.
    } catch (err) {
      if (err instanceof GmailApiError && err.isAuthError) {
        await db.from('gmail_config').update({ needs_reauth: true }).eq('id', cfg.id);
      }
      const message = err instanceof Error ? err.message : 'Unknown Gmail API error';
      console.error('[send-message] Gmail send failed:', message);
      return failSend(err, `Gmail send error: ${message}`);
    }
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql). The shared columns are built
  // above (`baseRow`) so a failed attempt stores exactly the same row.
  const { data: messageRecord, error: msgError } = await insertMessageRow({
    ...baseRow,
    // A widget send never gets a Meta wamid, so `waMessageId` stays ''.
    // Persist NULL there instead of '' — the unique index on
    // (conversation_id, message_id) (migration 037) treats NULLs as
    // distinct but not repeated empty strings, so a literal '' would
    // make every widget conversation's SECOND agent reply fail with a
    // unique violation.
    message_id: waMessageId || null,
    status: 'sent',
  });

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      isWidgetConversation
        ? `Failed to save message to DB: ${msgError.message}`
        : `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      last_channel_type: channel,
      // A reply — human, bot, or automation — closes the current wait
      // cycle regardless of channel (migration 049).
      awaiting_response: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
