import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ============================================================
// Full send path — what actually lands in `messages` (issue #483).
// ============================================================

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));

// Stub only the senders — the module also exports INTERACTIVE_LIMITS,
// which `interactive.ts` needs for the payload validation covered above.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  // Only used for the best-effort "pause active flow run" write.
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }),
  }),
}));

const sendMessengerText = vi.fn(async () => ({ messageId: 'msgr.1' }));
const sendMessengerMedia = vi.fn(async () => ({ messageId: 'msgr.media.1' }));
vi.mock('@/lib/messenger/meta-api', () => ({
  sendMessengerText: (...args: unknown[]) =>
    (sendMessengerText as unknown as (...a: unknown[]) => unknown)(...args),
  sendMessengerMedia: (...args: unknown[]) =>
    (sendMessengerMedia as unknown as (...a: unknown[]) => unknown)(...args),
}));

const sendInstagramText = vi.fn(async () => ({ messageId: 'ig.1' }));
const sendInstagramMedia = vi.fn(async () => ({ messageId: 'ig.media.1' }));
vi.mock('@/lib/instagram/meta-api', () => ({
  sendInstagramText: (...args: unknown[]) =>
    (sendInstagramText as unknown as (...a: unknown[]) => unknown)(...args),
  sendInstagramMedia: (...args: unknown[]) =>
    (sendInstagramMedia as unknown as (...a: unknown[]) => unknown)(...args),
}));

const sendNewMail = vi.fn(async () => undefined);
const sendReplyText = vi.fn(async () => undefined);
const sendReplyWithAttachment = vi.fn(async () => undefined);
vi.mock('@/lib/ms365/mail-api', () => ({
  sendNewMail: (...args: unknown[]) => (sendNewMail as unknown as (...a: unknown[]) => unknown)(...args),
  sendReplyText: (...args: unknown[]) =>
    (sendReplyText as unknown as (...a: unknown[]) => unknown)(...args),
  sendReplyWithAttachment: (...args: unknown[]) =>
    (sendReplyWithAttachment as unknown as (...a: unknown[]) => unknown)(...args),
}));

const getValidAccessToken = vi.fn(async () => 'access-token-1');
vi.mock('@/lib/ms365/token', () => ({
  getValidAccessToken: (...args: unknown[]) =>
    (getValidAccessToken as unknown as (...a: unknown[]) => unknown)(...args),
}));

const sendNewGmailMock = vi.fn(async () => ({ messageId: 'gm.1' }));
const sendGmailReplyMock = vi.fn(async () => ({ messageId: 'gm.reply.1' }));
const getGmailThreadingInfoMock = vi.fn(async () => ({
  threadId: 'thread-1',
  rfc822MessageId: '<abc@mail.gmail.com>',
  subject: 'Original subject',
}));
vi.mock('@/lib/gmail/gmail-api', () => ({
  sendNewMail: (...args: unknown[]) => (sendNewGmailMock as unknown as (...a: unknown[]) => unknown)(...args),
  sendReply: (...args: unknown[]) => (sendGmailReplyMock as unknown as (...a: unknown[]) => unknown)(...args),
  getThreadingInfo: (...args: unknown[]) =>
    (getGmailThreadingInfoMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

const getValidGmailAccessTokenMock = vi.fn(async () => 'gmail-access-token-1');
vi.mock('@/lib/gmail/token', () => ({
  getValidAccessToken: (...args: unknown[]) =>
    (getValidGmailAccessTokenMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Vircle Chat: the gateway call, the connection and the operator's flag are stubbed; their
// own tests cover them. Here we check what the send path does with their answers.
const sendToGatewayMock = vi.fn(async (..._args: unknown[]) => ({
  serverId: 'm_78',
  seq: 42,
  conversationId: 'c_9f2',
  delivery: 'socket' as const,
}));
const vircleConfig = { current: { id: 'vc-1', gateway_base_url: 'https://gw.example.com', enabled: true } as Record<string, unknown> | null };
const vircleFlag = { on: true };
vi.mock('@/lib/vircle-chat/gateway', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendToGateway: (...args: unknown[]) => sendToGatewayMock(...args),
}));
vi.mock('@/lib/vircle-chat/config', () => ({
  findConfigForAccount: async () => vircleConfig.current,
  openConfig: () => ({ signingSecret: 's', apiToken: 'tok' }),
}));
vi.mock('@/lib/vircle-chat/feature', () => ({ vircleChatEnabled: async () => vircleFlag.on }));
// The "read" ticks back to the app: covered by its own tests; here only when the send path asks for them.
const notifyReadsMock = vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0);
vi.mock('@/lib/vircle-chat/read-receipts', () => ({
  notifyVircleReads: (...args: unknown[]) => notifyReadsMock(...args),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

/**
 * Supabase fake covering the tables the send path touches. Each table
 * gets a builder that is both chainable and awaitable, so the same
 * object serves `.single()` lookups and the bare `select().eq().eq()`
 * the template resolver uses.
 */
type TestChannelType = 'whatsapp' | 'web_widget' | 'messenger' | 'instagram' | 'email' | 'gmail' | 'vircle_chat';

function sendPathDb(
  templateRows: unknown[],
  captured: CapturedWrites,
  contact: Record<string, unknown> = { id: 'ct-1', phone: '+15551234567' },
  channelType: TestChannelType = 'whatsapp',
  configOverrides: {
    messengerConfig?: Record<string, unknown> | null;
    instagramConfig?: Record<string, unknown> | null;
    emailConfig?: Record<string, unknown> | null;
    /** The `message_id` of the most recent inbound email in this
     *  conversation, if any — drives the reply-vs-sendNewMail branch. */
    emailLastInboundMessageId?: string | null;
    gmailConfig?: Record<string, unknown> | null;
    gmailLastInboundMessageId?: string | null;
    /** whatsapp_config row — override to test e.g. `enabled: false`. */
    whatsappConfig?: Record<string, unknown> | null;
    /** web_widget_config row — override to test e.g. `enabled: false`.
     *  Only queried for a web_widget conversation (migration 097). */
    webWidgetConfig?: Record<string, unknown> | null;
  } = {},
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact,
    last_channel_type: channelType,
    vircle_conversation_id: null as string | null,
  };
  const config =
    'whatsappConfig' in configOverrides
      ? configOverrides.whatsappConfig
      : { id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'token', enabled: true };
  const webWidgetConfig =
    'webWidgetConfig' in configOverrides
      ? configOverrides.webWidgetConfig
      : { id: 'wc-1', enabled: true };
  const messengerConfig =
    'messengerConfig' in configOverrides
      ? configOverrides.messengerConfig
      : { id: 'mc-1', page_id: 'page-1', page_access_token: 'page-token', enabled: true };
  const instagramConfig =
    'instagramConfig' in configOverrides
      ? configOverrides.instagramConfig
      : { id: 'ic-1', ig_business_account_id: 'ig-1', page_access_token: 'page-token', enabled: true };
  const emailConfig =
    'emailConfig' in configOverrides
      ? configOverrides.emailConfig
      : { id: 'ec-1', mailbox_address: 'agent@company.com', enabled: true };
  const emailLastInboundMessageId = configOverrides.emailLastInboundMessageId ?? null;
  const gmailConfig =
    'gmailConfig' in configOverrides
      ? configOverrides.gmailConfig
      : { id: 'gc-1', email_address: 'agent@gmail.com', enabled: true };
  const gmailLastInboundMessageId = configOverrides.gmailLastInboundMessageId ?? null;
  const configUpdates: Record<string, Record<string, unknown>> = {};

  return {
    from(table: string) {
      if (channelType !== 'whatsapp' && table === 'whatsapp_config') {
        throw new Error(`whatsapp_config should not be queried for a ${channelType} conversation`);
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          if (
            table === 'messenger_config' ||
            table === 'instagram_config' ||
            table === 'email_config' ||
            table === 'gmail_config'
          ) {
            configUpdates[table] = row;
          }
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'messages') {
            const lastInboundId = gmailLastInboundMessageId ?? emailLastInboundMessageId;
            return lastInboundId
              ? { data: { message_id: lastInboundId }, error: null }
              : { data: null, error: null };
          }
          if (table === 'web_widget_config') {
            return { data: webWidgetConfig, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'whatsapp_config') return { data: config, error: null };
          if (table === 'messenger_config') {
            return messengerConfig
              ? { data: messengerConfig, error: null }
              : { data: null, error: { message: 'not found' } };
          }
          if (table === 'instagram_config') {
            return instagramConfig
              ? { data: instagramConfig, error: null }
              : { data: null, error: { message: 'not found' } };
          }
          if (table === 'email_config') {
            return emailConfig
              ? { data: emailConfig, error: null }
              : { data: null, error: { message: 'not found' } };
          }
          if (table === 'gmail_config') {
            return gmailConfig
              ? { data: gmailConfig, error: null }
              : { data: null, error: { message: 'not found' } };
          }
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
        // Bare-await result — only message_templates is read this way.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? templateRows : [],
            error: null,
          }),
      };
      return builder;
    },
    __configUpdates: configUpdates,
  } as unknown as SupabaseClient & { __configUpdates: Record<string, Record<string, unknown>> };
}

const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(result.whatsappMessageId).toBe('wamid.1');
    // Was NULL before the fix — the Inbox rendered an empty bubble.
    expect(captured.message?.content_text).toBe(
      'Your order A123 ships on Friday'
    );
    expect(captured.message?.template_name).toBe('order_update');
    // …and the conversation-list preview reads the body, not '[template]'.
    expect(captured.conversation?.last_message_text).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateMessageParams: { body: ['B456', 'Monday'] },
    });
    expect(captured.message?.content_text).toBe(
      'Your order B456 ships on Monday'
    );
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
      contentText: 'rendered by the composer',
    });
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it("sends the local row's language when the caller names none", async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
    });
    // Previously pinned to 'en_US', which matched no row and made Meta
    // reject the send as a missing translation.
    expect(
      (sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }])[0]
        .language
    ).toBe('en');
  });

  it('leaves content_text null when the account has no local template row', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'never_synced',
      templateParams: ['A123'],
    });
    // Nothing to render from — the bubble falls back to the template
    // name rather than inventing a body.
    expect(captured.message?.content_text).toBeNull();
    expect(captured.conversation?.last_message_text).toBe('[template]');
  });
});

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta withholds the phone number for a customer who has adopted a
// WhatsApp username, so their contact row carries only `wa_user_id`.
// The send path used to reject those outright with "Contact phone
// number not found" — the business could receive their messages but
// never answer them.
// ============================================================

const BSUID = 'US.13491208655302741918';

describe('sendMessageToConversation — BSUID recipients (#519)', () => {
  it('sends to the BSUID when the contact has no phone number', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', wa_user_id: BSUID }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: BSUID })
    );
  });

  it('still prefers the phone number when the contact has both', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, {
        id: 'ct-1',
        phone: '+15551234567',
        wa_user_id: BSUID,
      }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    // Only the phone path supports the trunk-prefix variant retry, so
    // it wins whenever we have a usable number.
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: '15551234567' })
    );
  });

  it('falls back to the BSUID when the stored phone is unusable', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, {
        id: 'ct-1',
        phone: 'not-a-number',
        wa_user_id: BSUID,
      }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: BSUID })
    );
  });

  it('400s when the contact has neither a usable phone nor a BSUID', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no phone number or WhatsApp user ID/);
  });

  it('ignores a wa_user_id that is not BSUID-shaped', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, {
          id: 'ct-1',
          phone: '',
          wa_user_id: 'garbage',
        }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no phone number or WhatsApp user ID/);
  });
});

// ============================================================
// Web-widget channel (migration 046) — persisting the row IS the
// delivery; Meta/whatsapp_config must never be touched.
// ============================================================

describe('sendMessageToConversation — sender attribution (Leaderboard/Users reports)', () => {
  it('persists senderUserId onto sender_id for an agent send', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
      senderUserId: 'user-1',
    });
    expect(captured.message?.sender_id).toBe('user-1');
  });

  it('never attributes a bot send to a human, even if senderUserId is passed', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'auto-reply',
      senderType: 'bot',
      senderUserId: 'user-1',
    });
    expect(captured.message?.sender_id).toBeNull();
  });
});

describe('sendMessageToConversation — web_widget channel', () => {
  it('persists a text message without ever querying whatsapp_config', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', widget_visitor_id: 'v-1' }, 'web_widget'),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi from the widget' }
    );

    // No Meta wamid for a widget send — the DB row is the delivery.
    expect(result.whatsappMessageId).toBe('');
    expect(captured.message?.content_text).toBe('hi from the widget');
    // NULL, not '' — a literal '' would collide with itself under the
    // (conversation_id, message_id) unique index (migration 037) on any
    // second widget send in the same conversation. See the regression
    // test below.
    expect(captured.message?.message_id).toBeNull();
  });

  it('persists NULL message_id on every send in the same conversation, not just the first', async () => {
    // Regression for the bug where widget sends persisted message_id: ''
    // — a literal empty string is not distinct from itself under the
    // plain unique index on (conversation_id, message_id), so a second
    // agent reply in the same widget conversation failed with a Postgres
    // 23505 unique violation. NULL is always distinct from NULL, so this
    // asserts the fix holds across repeated sends.
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', widget_visitor_id: 'v-1' }, 'web_widget');

    const first = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'first reply',
    });
    expect(captured.message?.message_id).toBeNull();

    const second = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'second reply',
    });
    expect(captured.message?.message_id).toBeNull();

    expect(first.whatsappMessageId).toBe('');
    expect(second.whatsappMessageId).toBe('');
  });

  it('rejects templates and interactive messages for a widget conversation', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'web_widget'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'template', templateName: 'order_update' }
      )
    ).rejects.toThrow(/Only text and media messages are supported/);
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'web_widget'),
        'acct-1',
        {
          conversationId: 'cv-1',
          messageType: 'interactive',
          interactivePayload: { kind: 'buttons', body: 'Pick one', buttons: [{ id: 'a', title: 'A' }] },
        }
      )
    ).rejects.toThrow(/Only text and media messages are supported/);
  });

  it.each(['image', 'video', 'audio', 'document'] as const)(
    'persists a %s message for a widget conversation without contacting Meta',
    async (kind) => {
      const captured: CapturedWrites = {};
      const result = await sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'web_widget'),
        'acct-1',
        {
          conversationId: 'cv-1',
          messageType: kind,
          mediaUrl: 'https://example.test/storage/v1/object/public/chat-media/account-1/file.bin',
          contentText: 'a caption',
          filename: 'file.bin',
        }
      );
      expect(result.whatsappMessageId).toBe('');
      expect(captured.message?.content_type).toBe(kind);
      expect(captured.message?.media_url).toContain('/chat-media/');
      expect(captured.message?.channel_type).toBe('web_widget');
      expect(captured.message?.status).toBe('sent');
      expect(captured.message?.message_id).toBeNull();
    }
  );
});

// ============================================================
// Messenger / Instagram channels (migration 055) — real Graph API
// calls via the connected Page/IG business account, unlike the
// widget's no-op branch.
// ============================================================

describe('sendMessageToConversation — messenger channel', () => {
  it('sends via the Messenger Send API and persists the result', async () => {
    sendMessengerText.mockClear();
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', messenger_psid: 'psid-1' }, 'messenger'),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi from the page' }
    );

    expect(sendMessengerText).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-1', recipientPsid: 'psid-1', text: 'hi from the page' })
    );
    expect(result.whatsappMessageId).toBe('msgr.1');
    expect(captured.message?.channel_type).toBe('messenger');
    expect(captured.message?.message_id).toBe('msgr.1');
  });

  it('sends media via the Messenger Send API, mapping document → file', async () => {
    sendMessengerMedia.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', messenger_psid: 'psid-1' }, 'messenger'),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'document', mediaUrl: 'https://x/y.pdf' }
    );
    expect(sendMessengerMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'file', url: 'https://x/y.pdf' })
    );
  });

  it('400s when the contact has no Messenger identity', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'messenger'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no Messenger identity/);
  });

  it('400s when Messenger is not connected', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb(
          [],
          captured,
          { id: 'ct-1', phone: '', messenger_psid: 'psid-1' },
          'messenger',
          { messengerConfig: null },
        ),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/Messenger is not connected/);
  });

  it('rejects template and interactive message types', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', messenger_psid: 'psid-1' }, 'messenger'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'template', templateName: 'order_update' }
      )
    ).rejects.toThrow(/Only text and media messages/);
  });

  it('flips needs_reauth on a Meta OAuthException (code 190)', async () => {
    const { MetaApiError } = await import('@/lib/meta/errors');
    sendMessengerText.mockRejectedValueOnce(
      new MetaApiError('Token expired', { code: 190, httpStatus: 401 }),
    );
    const captured: CapturedWrites = {};
    const db = sendPathDb(
      [],
      captured,
      { id: 'ct-1', phone: '', messenger_psid: 'psid-1' },
      'messenger',
    ) as SupabaseClient & { __configUpdates: Record<string, Record<string, unknown>> };

    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hi',
      })
    ).rejects.toThrow(/Messenger API error/);

    expect(db.__configUpdates.messenger_config).toMatchObject({ needs_reauth: true });
  });
});

describe('sendMessageToConversation — instagram channel', () => {
  it('sends via the Instagram Messaging API and persists the result', async () => {
    sendInstagramText.mockClear();
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', instagram_igsid: 'igsid-1' }, 'instagram'),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi from the grid' }
    );

    expect(sendInstagramText).toHaveBeenCalledWith(
      expect.objectContaining({
        igBusinessAccountId: 'ig-1',
        recipientIgsid: 'igsid-1',
        text: 'hi from the grid',
      })
    );
    expect(result.whatsappMessageId).toBe('ig.1');
    expect(captured.message?.channel_type).toBe('instagram');
  });

  it('400s when the contact has no Instagram identity', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'instagram'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no Instagram identity/);
  });

  it('400s when Instagram is not connected', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb(
          [],
          captured,
          { id: 'ct-1', phone: '', instagram_igsid: 'igsid-1' },
          'instagram',
          { instagramConfig: null },
        ),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/Instagram is not connected/);
  });

  it('rejects template and interactive message types', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', instagram_igsid: 'igsid-1' }, 'instagram'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'template', templateName: 'order_update' }
      )
    ).rejects.toThrow(/Only text and media messages/);
  });
});

// ============================================================
// Email channel (migration 056) — Microsoft Graph, via the connected
// Microsoft 365 mailbox. Unlike Messenger/Instagram, sending has two
// shapes depending on whether there's a prior inbound message to
// thread a reply onto — see send-message.ts's email branch.
// ============================================================
describe('sendMessageToConversation — email channel', () => {
  it('sends a fresh email (sendNewMail) when there is no prior inbound message', async () => {
    sendNewMail.mockClear();
    sendReplyText.mockClear();
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'email'),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'Hi Jane' }
    );

    expect(sendNewMail).toHaveBeenCalledWith(
      expect.objectContaining({ toAddress: 'jane@example.com', text: 'Hi Jane' })
    );
    expect(sendReplyText).not.toHaveBeenCalled();
    // No Graph message id comes back from sendMail — same NULL
    // convention as a widget send (see the message_id comment above).
    expect(result.whatsappMessageId).toBe('');
    expect(captured.message?.channel_type).toBe('email');
    expect(captured.message?.message_id).toBeNull();
  });

  it('threads a real reply (sendReplyText) when there is a prior inbound message', async () => {
    sendNewMail.mockClear();
    sendReplyText.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb(
        [],
        captured,
        { id: 'ct-1', phone: '', email: 'jane@example.com' },
        'email',
        { emailLastInboundMessageId: 'graph-msg-1' },
      ),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'Following up' }
    );

    expect(sendReplyText).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'graph-msg-1', text: 'Following up' })
    );
    expect(sendNewMail).not.toHaveBeenCalled();
  });

  it('400s when the contact has no email address', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'email'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no email address/);
  });

  it('400s when Email is not connected', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb(
          [],
          captured,
          { id: 'ct-1', phone: '', email: 'jane@example.com' },
          'email',
          { emailConfig: null },
        ),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/Email is not connected/);
  });

  it('rejects template and interactive message types', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'email'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'template', templateName: 'order_update' }
      )
    ).rejects.toThrow(/Only text and media messages/);
  });

  it('flips needs_reauth on a Graph auth error', async () => {
    const { GraphApiError } = await import('@/lib/ms365/errors');
    sendNewMail.mockRejectedValueOnce(new GraphApiError('Token expired', { httpStatus: 401 }));
    const captured: CapturedWrites = {};
    const db = sendPathDb(
      [],
      captured,
      { id: 'ct-1', phone: '', email: 'jane@example.com' },
      'email',
    ) as SupabaseClient & { __configUpdates: Record<string, Record<string, unknown>> };

    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hi',
      })
    ).rejects.toThrow(/Email send error/);

    expect(db.__configUpdates.email_config).toMatchObject({ needs_reauth: true });
  });
});

// ============================================================
// Gmail channel (migration 058) — separate from the Microsoft 365
// Email channel above even though both are "email". Threading needs
// an extra getThreadingInfo lookup Microsoft 365 doesn't (Gmail's
// in-reply-to header and threadId aren't the same as the stored
// message_id) — see send-message.ts's gmail branch.
// ============================================================
describe('sendMessageToConversation — gmail channel', () => {
  it('sends a fresh email (sendNewMail) when there is no prior inbound message', async () => {
    sendNewGmailMock.mockClear();
    sendGmailReplyMock.mockClear();
    getGmailThreadingInfoMock.mockClear();
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'gmail'),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'Hi Jane' }
    );

    expect(sendNewGmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ toAddress: 'jane@example.com', text: 'Hi Jane' })
    );
    expect(sendGmailReplyMock).not.toHaveBeenCalled();
    expect(getGmailThreadingInfoMock).not.toHaveBeenCalled();
    expect(result.whatsappMessageId).toBe('');
    expect(captured.message?.channel_type).toBe('gmail');
    expect(captured.message?.message_id).toBeNull();
  });

  it('threads a real reply (sendReply) using fresh threading info when there is a prior inbound message', async () => {
    sendNewGmailMock.mockClear();
    sendGmailReplyMock.mockClear();
    getGmailThreadingInfoMock.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb(
        [],
        captured,
        { id: 'ct-1', phone: '', email: 'jane@example.com' },
        'gmail',
        { gmailLastInboundMessageId: 'gmail-msg-1' },
      ),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'Following up' }
    );

    expect(getGmailThreadingInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'gmail-msg-1' })
    );
    expect(sendGmailReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        inReplyToMessageId: '<abc@mail.gmail.com>',
        subject: 'Re: Original subject',
        text: 'Following up',
      })
    );
    expect(sendNewGmailMock).not.toHaveBeenCalled();
  });

  it('does not double-prefix an already-"Re:" subject', async () => {
    sendGmailReplyMock.mockClear();
    getGmailThreadingInfoMock.mockClear();
    getGmailThreadingInfoMock.mockResolvedValueOnce({
      threadId: 'thread-2',
      rfc822MessageId: '<def@mail.gmail.com>',
      subject: 'Re: Already replied once',
    });
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb(
        [],
        captured,
        { id: 'ct-1', phone: '', email: 'jane@example.com' },
        'gmail',
        { gmailLastInboundMessageId: 'gmail-msg-2' },
      ),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'Still following up' }
    );

    expect(sendGmailReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Re: Already replied once' })
    );
  });

  it('400s when the contact has no email address', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'gmail'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no email address/);
  });

  it('400s when Gmail is not connected', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb(
          [],
          captured,
          { id: 'ct-1', phone: '', email: 'jane@example.com' },
          'gmail',
          { gmailConfig: null },
        ),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/Gmail is not connected/);
  });

  it('rejects template and interactive message types', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'gmail'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'template', templateName: 'order_update' }
      )
    ).rejects.toThrow(/Only text and media messages/);
  });

  it('flips needs_reauth on a Gmail auth error', async () => {
    const { GmailApiError } = await import('@/lib/gmail/errors');
    sendNewGmailMock.mockRejectedValueOnce(new GmailApiError('Token expired', { httpStatus: 401 }));
    const captured: CapturedWrites = {};
    const db = sendPathDb(
      [],
      captured,
      { id: 'ct-1', phone: '', email: 'jane@example.com' },
      'gmail',
    ) as SupabaseClient & { __configUpdates: Record<string, Record<string, unknown>> };

    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hi',
      })
    ).rejects.toThrow(/Gmail send error/);

    expect(db.__configUpdates.gmail_config).toMatchObject({ needs_reauth: true });
  });
});

// ============================================================
// A send the channel rejects is kept as a failed message (batch 2).
// ============================================================
describe('sendMessageToConversation — failed sends are saved with the reason', () => {
  async function metaErr(code: number, message: string, details?: string) {
    const { MetaApiError } = await import('@/lib/meta/errors');
    return new MetaApiError(message, { code, httpStatus: 400, details });
  }

  it('WhatsApp: saves the message as failed with code, title and details, then still throws', async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockRejectedValueOnce(
      await metaErr(131047, '(#131047) Re-engagement message', 'More than 24 hours have passed')
    );
    const captured: CapturedWrites = {};

    const err = await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hello there',
      senderUserId: 'agent-1',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('meta_error');
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/Meta API error/);
    expect(err.failedMessageId).toBe('msg-1');
    expect(err.failure).toEqual({
      code: 131047,
      title: 'Re-engagement message',
      details: 'More than 24 hours have passed',
    });

    expect(captured.message).toMatchObject({
      status: 'failed',
      message_id: null,
      sender_type: 'agent',
      sender_id: 'agent-1',
      content_type: 'text',
      content_text: 'hello there',
      channel_type: 'whatsapp',
      error_code: 131047,
      error_title: 'Re-engagement message',
      error_details: 'More than 24 hours have passed',
    });
  });

  it('only sets last_message_failed — never touches the preview, unread or awaiting-response flag', async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockRejectedValueOnce(await metaErr(131030, 'Not allowed'));
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'x',
    }).catch(() => undefined);
    expect(captured.message?.status).toBe('failed');
    // A message that did not go out must not read as a reply — the only field
    // insertFailedMessageRow is allowed to touch is this one new flag.
    expect(captured.conversation).toEqual({ last_message_failed: true });
  });

  it('keeps the media url and caption on a failed media send', async () => {
    const { sendMediaMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendMediaMessage).mockRejectedValueOnce(await metaErr(131053, 'Media upload error'));
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'document',
        mediaUrl: 'https://cdn/x/report.pdf',
        contentText: 'The report',
        filename: 'report.pdf',
      })
    ).rejects.toBeInstanceOf(SendMessageError);
    expect(captured.message).toMatchObject({
      status: 'failed',
      content_type: 'document',
      media_url: 'https://cdn/x/report.pdf',
      content_text: 'The report',
      send_payload: { filename: 'report.pdf' },
    });
  });

  describe('files in the private chat-media bucket', () => {
    const own = 'https://x.supabase.co/storage/v1/object/public/chat-media/account-acct-1/inbound/pic.png'
    const foreign = 'https://x.supabase.co/storage/v1/object/public/chat-media/account-acct-2/pic.png'
    const withStorage = (db: SupabaseClient) => {
      const createSignedUrl = vi.fn(async (path: string) => ({
        data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/chat-media/${path}?token=t` },
        error: null,
      }))
      return { db: Object.assign(db, { storage: { from: () => ({ createSignedUrl }) } }), createSignedUrl }
    }

    it('gives Meta a signed link minted now, and stores the identifier', async () => {
      const { sendMediaMessage } = await import('@/lib/whatsapp/meta-api')
      vi.mocked(sendMediaMessage).mockClear()
      const captured: CapturedWrites = {}
      const { db, createSignedUrl } = withStorage(sendPathDb([], captured))
      await sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'image',
        mediaUrl: own,
      })
      expect(createSignedUrl).toHaveBeenCalledWith('account-acct-1/inbound/pic.png', 3600)
      expect(vi.mocked(sendMediaMessage).mock.calls[0][0].link).toBe(
        'https://x.supabase.co/storage/v1/object/sign/chat-media/account-acct-1/inbound/pic.png?token=t',
      )
      expect(captured.message?.media_url).toBe(own)
    })

    it('refuses to send a file from another workspace, and never signs it', async () => {
      const { sendMediaMessage } = await import('@/lib/whatsapp/meta-api')
      vi.mocked(sendMediaMessage).mockClear()
      const { db, createSignedUrl } = withStorage(sendPathDb([], {}))
      await expect(
        sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'image', mediaUrl: foreign }),
      ).rejects.toBeInstanceOf(SendMessageError)
      expect(createSignedUrl).not.toHaveBeenCalled()
      expect(sendMediaMessage).not.toHaveBeenCalled()
    })
  })

  it('keeps the template name, substituted body, language and params so a resend can rebuild it', async () => {
    sendTemplateMessage.mockRejectedValueOnce(await metaErr(132001, 'Template does not exist'));
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateLanguage: 'en',
        templateParams: ['A123', 'Friday'],
      })
    ).rejects.toBeInstanceOf(SendMessageError);
    expect(captured.message).toMatchObject({
      status: 'failed',
      content_type: 'template',
      template_name: 'order_update',
      content_text: 'Your order A123 ships on Friday',
      send_payload: { template_language: 'en', template_params: ['A123', 'Friday'] },
    });
  });

  it('Messenger: saves the failure on the messenger channel and still flips needs_reauth on 190', async () => {
    sendMessengerText.mockRejectedValueOnce(await metaErr(190, 'Token expired'));
    const captured: CapturedWrites = {};
    const db = sendPathDb(
      [],
      captured,
      { id: 'ct-1', phone: '', messenger_psid: 'psid-1' },
      'messenger'
    ) as SupabaseClient & { __configUpdates: Record<string, Record<string, unknown>> };

    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hi',
      })
    ).rejects.toThrow(/Messenger API error/);

    expect(db.__configUpdates.messenger_config).toMatchObject({ needs_reauth: true });
    expect(captured.message).toMatchObject({
      status: 'failed',
      channel_type: 'messenger',
      message_id: null,
      error_code: 190,
    });
  });

  it('Instagram: saves the failure', async () => {
    sendInstagramText.mockRejectedValueOnce(await metaErr(10, 'Outside of allowed window'));
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', instagram_igsid: 'ig-1' }, 'instagram'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/Instagram API error/);
    expect(captured.message).toMatchObject({ status: 'failed', channel_type: 'instagram', error_code: 10 });
  });

  it('Email (Microsoft 365): an auth failure is stored as code 401', async () => {
    const { GraphApiError } = await import('@/lib/ms365/errors');
    sendNewMail.mockRejectedValueOnce(new GraphApiError('Token expired', { httpStatus: 401 }));
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'email'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi', contentHtml: '<p>hi</p>' }
      )
    ).rejects.toThrow(/Email send error/);
    expect(captured.message).toMatchObject({
      status: 'failed',
      channel_type: 'email',
      error_code: 401,
      content_html: '<p>hi</p>',
    });
  });

  it('Gmail: saves the failure', async () => {
    const { GmailApiError } = await import('@/lib/gmail/errors');
    sendNewGmailMock.mockRejectedValueOnce(new GmailApiError('Quota exceeded', { httpStatus: 429 }));
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'gmail'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/Gmail send error/);
    expect(captured.message).toMatchObject({
      status: 'failed',
      channel_type: 'gmail',
      error_code: null,
      error_title: 'Quota exceeded',
    });
  });

  it('bot sends (automation, AI) keep their sender type and AI flag on the failed row', async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockRejectedValueOnce(await metaErr(131056, 'Pair rate limit'));
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'auto',
        senderType: 'bot',
        aiGenerated: true,
        senderUserId: 'agent-1',
      })
    ).rejects.toBeInstanceOf(SendMessageError);
    expect(captured.message).toMatchObject({
      status: 'failed',
      sender_type: 'bot',
      sender_id: null,
      ai_generated: true,
    });
  });

  it('persistFailedAttempt: false (used by Resend) saves nothing and reports no failed id', async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockRejectedValueOnce(await metaErr(131047, 'window'));
    const captured: CapturedWrites = {};
    const err = await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'x',
      persistFailedAttempt: false,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.failedMessageId).toBeNull();
    expect(err.failure?.code).toBe(131047);
    expect(captured.message).toBeUndefined();
  });

  it('does NOT save a ghost row for errors that happen before anything is sent', async () => {
    const captured: CapturedWrites = {};
    // No Messenger identity on the contact.
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'messenger'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no Messenger identity/);
    // Channel not connected.
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', messenger_psid: 'p' }, 'messenger', {
          messengerConfig: null,
        }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/not connected/);
    // Invalid phone number on WhatsApp.
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: 'abc' }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toBeInstanceOf(SendMessageError);
    // A template on a channel that has none.
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '', messenger_psid: 'p' }, 'messenger'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'template', templateName: 'x' }
      )
    ).rejects.toThrow(/Only text and media/);
    expect(captured.message).toBeUndefined();
  });

  it('a failure while saving the failed row does not hide the real error', async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockRejectedValueOnce(await metaErr(190, 'Token expired'));
    const captured: CapturedWrites = {};
    const inner = sendPathDb([], captured);
    const db = {
      from(table: string) {
        const b = (inner as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
        if (table === 'messages') {
          b.insert = () => ({
            select: () => ({ single: async () => ({ data: null, error: { message: 'db is down' } }) }),
          });
        }
        return b;
      },
    } as unknown as SupabaseClient;

    const err = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'x',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('meta_error');
    expect(err.failedMessageId).toBeNull();
    expect(err.failure?.code).toBe(190);
  });

  it('a database without migration 094 still saves a template send (retries without send_payload)', async () => {
    const inserts: Record<string, unknown>[] = [];
    const captured: CapturedWrites = {};
    const inner = sendPathDb([TEMPLATE_ROW], captured);
    const db = {
      from(table: string) {
        const b = (inner as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
        if (table === 'messages') {
          b.insert = (row: Record<string, unknown>) => {
            inserts.push(row);
            const first = inserts.length === 1;
            return {
              select: () => ({
                single: async () =>
                  first
                    ? { data: null, error: { message: 'column "send_payload" of relation "messages" does not exist' } }
                    : { data: { id: 'msg-2' }, error: null },
              }),
            };
          };
        }
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateLanguage: 'en',
      templateParams: ['A123', 'Friday'],
    });
    expect(result.messageId).toBe('msg-2');
    expect(inserts).toHaveLength(2);
    expect('send_payload' in inserts[0]).toBe(true);
    expect('send_payload' in inserts[1]).toBe(false);
    expect(inserts[1].status).toBe('sent');
  });

  it('a plain text send never writes send_payload', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hello',
    });
    expect(captured.message).toBeDefined();
    expect('send_payload' in (captured.message as object)).toBe(false);
    expect(captured.message?.status).toBe('sent');
  });
});

// ============================================================
// "Disable without disconnecting" (migration 097) — a channel with
// enabled: false blocks outbound sends with a clear, dedicated error
// while leaving its saved credentials untouched. One regression per
// channel, mirroring each channel's own "not configured" test above
// but with a config ROW present and enabled: false, rather than no
// config row at all.
// ============================================================
describe('sendMessageToConversation — disabled channel (migration 097)', () => {
  it('blocks a WhatsApp send when whatsapp_config.enabled is false', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, undefined, 'whatsapp', {
      whatsappConfig: { id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'token', enabled: false },
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow(/WhatsApp is currently disabled/);
    await sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }).catch(
      (e: SendMessageError) => {
        expect(e.code).toBe('channel_disabled');
        expect(e.status).toBe(400);
      }
    );
    expect(captured.message).toBeUndefined();
  });

  it('blocks a web widget send when web_widget_config.enabled is false — closes the agent-side outbound gap', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', widget_visitor_id: 'v-1' }, 'web_widget', {
      webWidgetConfig: { id: 'wc-1', enabled: false },
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow(/web widget is currently disabled/);
    expect(captured.message).toBeUndefined();
  });

  it('blocks a Messenger send when messenger_config.enabled is false', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', messenger_psid: 'psid-1' }, 'messenger', {
      messengerConfig: { id: 'mc-1', page_id: 'page-1', page_access_token: 'page-token', enabled: false },
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow(/Messenger is currently disabled/);
    expect(sendMessengerText).not.toHaveBeenCalled();
  });

  it('blocks an Instagram send when instagram_config.enabled is false', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', instagram_igsid: 'igsid-1' }, 'instagram', {
      instagramConfig: { id: 'ic-1', ig_business_account_id: 'ig-1', page_access_token: 'page-token', enabled: false },
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow(/Instagram is currently disabled/);
    expect(sendInstagramText).not.toHaveBeenCalled();
  });

  it('blocks an Email send when email_config.enabled is false', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'email', {
      emailConfig: { id: 'ec-1', mailbox_address: 'agent@company.com', enabled: false },
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow(/Email is currently disabled/);
    expect(sendNewMail).not.toHaveBeenCalled();
  });

  it('blocks an Email send when the mailbox is not used for the customer care inbox (inbox_enabled false), with a clear error, even though it is connected and not paused', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'email', {
      emailConfig: { id: 'ec-1', mailbox_address: 'agent@company.com', enabled: true, inbox_enabled: false },
    });
    const err = await sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('email_inbox_off');
    expect(err.status).toBe(400);
    expect(err.message).toBe('The email inbox is switched off. Turn it on in Settings > Channels > Email to reply.');
    expect(sendNewMail).not.toHaveBeenCalled();
    expect(sendReplyText).not.toHaveBeenCalled();
    // nothing was stored as a message
    expect(captured.message).toBeUndefined();
  });

  it('still sends an Email when inbox_enabled is true or the column does not exist yet', async () => {
    for (const emailConfig of [
      { id: 'ec-1', mailbox_address: 'agent@company.com', enabled: true, inbox_enabled: true },
      { id: 'ec-1', mailbox_address: 'agent@company.com', enabled: true },
    ]) {
      const captured: CapturedWrites = {};
      const db = sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'email', { emailConfig });
      await sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' });
    }
    expect(sendNewMail).toHaveBeenCalledTimes(2);
  });

  it('says the pause first when the mailbox is both paused and not used for the inbox', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'email', {
      emailConfig: { id: 'ec-1', mailbox_address: 'agent@company.com', enabled: false, inbox_enabled: false },
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow(/Email is currently disabled/);
  });

  it('blocks a Gmail send when the mailbox is not used for the customer care inbox (inbox_enabled false)', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'gmail', {
      gmailConfig: { id: 'gc-1', email_address: 'agent@gmail.com', enabled: true, inbox_enabled: false },
    });
    const err = await sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('email_inbox_off');
    expect(err.message).toBe('The Gmail inbox is switched off. Turn it on in Settings > Channels > Gmail to reply.');
    expect(sendNewGmailMock).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });

  it('blocks a Gmail send when gmail_config.enabled is false', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, { id: 'ct-1', phone: '', email: 'jane@example.com' }, 'gmail', {
      gmailConfig: { id: 'gc-1', email_address: 'agent@gmail.com', enabled: false },
    });
    await expect(
      sendMessageToConversation(db, 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow(/Gmail is currently disabled/);
    expect(sendNewGmailMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// Vircle Chat channel (migration 147)
// ============================================================
describe('sendMessageToConversation — Vircle Chat channel', () => {
  const contact = { id: 'ct-1', phone: '', wallet_id: 'W123', email: null };
  const send = (db: SupabaseClient, params: Partial<SendMessageParams> = {}) =>
    sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hi Aisha, checking now.',
      ...params,
    });

  const reset = () => {
    sendToGatewayMock.mockClear();
    notifyReadsMock.mockClear();
    vircleConfig.current = { id: 'vc-1', gateway_base_url: 'https://gw.example.com', enabled: true };
    vircleFlag.on = true;
  };

  it('sends through the gateway with the message id as the idempotency key and stores the gateway id', async () => {
    reset();
    const captured: CapturedWrites = {};
    const result = await send(sendPathDb([], captured, contact, 'vircle_chat'));

    expect(sendToGatewayMock).toHaveBeenCalledTimes(1);
    const [conn, msg] = sendToGatewayMock.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(conn).toEqual({ baseUrl: 'https://gw.example.com', apiToken: 'tok' });
    expect(msg).toMatchObject({ walletId: 'W123', type: 'text', text: 'Hi Aisha, checking now.', media: null, conversationId: null });
    // The same id is the stored row's id, so a retry after a crash cannot send twice.
    expect(msg.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured.message?.id).toBe(msg.idempotencyKey);
    expect(captured.message).toMatchObject({ channel_type: 'vircle_chat', message_id: 'm_78', status: 'sent' });
    expect(result.whatsappMessageId).toBe('m_78');
  });

  it('sends a file as a signed link with a guessed type', async () => {
    reset();
    const db = sendPathDb([], {}, contact, 'vircle_chat');
    await send(db, { messageType: 'image', mediaUrl: 'https://cdn.example.com/a/photo.PNG', contentText: undefined });
    const msg = sendToGatewayMock.mock.calls[0][1] as { media: Record<string, unknown>; type: string };
    expect(msg.type).toBe('image');
    expect(msg.media).toMatchObject({ url: 'https://cdn.example.com/a/photo.PNG', mimeType: 'image/png' });
  });

  it('refuses a contact without a wallet id, before calling the gateway', async () => {
    reset();
    await expect(send(sendPathDb([], {}, { id: 'ct-1', phone: '' }, 'vircle_chat'))).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    expect(sendToGatewayMock).not.toHaveBeenCalled();
  });

  it('refuses when Vircle Chat is not connected, paused, or switched off by the operator', async () => {
    reset();
    vircleConfig.current = null;
    await expect(send(sendPathDb([], {}, contact, 'vircle_chat'))).rejects.toMatchObject({ code: 'vircle_chat_not_configured' });

    reset();
    vircleConfig.current = { id: 'vc-1', gateway_base_url: 'https://gw.example.com', enabled: false };
    await expect(send(sendPathDb([], {}, contact, 'vircle_chat'))).rejects.toMatchObject({ code: 'channel_disabled' });

    reset();
    vircleFlag.on = false;
    await expect(send(sendPathDb([], {}, contact, 'vircle_chat'))).rejects.toMatchObject({ code: 'channel_disabled' });
    expect(sendToGatewayMock).not.toHaveBeenCalled();
  });

  it('saves a failed bubble with the mapped reason when the gateway refuses', async () => {
    reset();
    const { GatewayError } = await import('@/lib/vircle-chat/gateway');
    sendToGatewayMock.mockRejectedValueOnce(new GatewayError('user_not_found', 'No such user', 404, false));
    const captured: CapturedWrites = {};
    await expect(send(sendPathDb([], captured, contact, 'vircle_chat'))).rejects.toBeInstanceOf(SendMessageError);
    expect(captured.message).toMatchObject({
      status: 'failed',
      channel_type: 'vircle_chat',
      error_code: 551,
    });
    expect(String(captured.message?.error_details)).toContain('user_not_found');
  });

  it("passes the quoted message's gateway id to the gateway as replyToServerId (contract 1.2)", async () => {
    reset();
    // The fake answers the parent lookup with the gateway id of the message being quoted.
    const db = sendPathDb([], {}, contact, 'vircle_chat', { emailLastInboundMessageId: 'm_41' });
    await send(db, { replyToMessageId: 'parent-uuid' });
    const msg = sendToGatewayMock.mock.calls[0][1] as Record<string, unknown>;
    expect(msg.replyToServerId).toBe('m_41');
  });

  it('sends no reply target for a message that is not a reply', async () => {
    reset();
    await send(sendPathDb([], {}, contact, 'vircle_chat'));
    const msg = sendToGatewayMock.mock.calls[0][1] as Record<string, unknown>;
    expect(msg.replyToServerId ?? null).toBeNull();
  });

  it('after an agent reply goes out, retries any "read" tick the app has not been told about', async () => {
    reset();
    await send(sendPathDb([], {}, contact, 'vircle_chat'));
    expect(notifyReadsMock).toHaveBeenCalledTimes(1);
    expect(notifyReadsMock).toHaveBeenCalledWith(expect.anything(), 'acct-1', 'cv-1');
  });

  it('does not report reads for a bot reply, or when the send failed', async () => {
    reset();
    await send(sendPathDb([], {}, contact, 'vircle_chat'), { senderType: 'bot' });
    expect(notifyReadsMock).not.toHaveBeenCalled();

    const { GatewayError } = await import('@/lib/vircle-chat/gateway');
    sendToGatewayMock.mockRejectedValueOnce(new GatewayError('unreachable', 'down', 0, true));
    await expect(send(sendPathDb([], {}, contact, 'vircle_chat'))).rejects.toBeInstanceOf(SendMessageError);
    expect(notifyReadsMock).not.toHaveBeenCalled();
  });

  it('does not text a web-chat style template or interactive message', async () => {
    reset();
    await expect(
      send(sendPathDb([], {}, contact, 'vircle_chat'), { messageType: 'template', templateName: 'hello', contentText: undefined }),
    ).rejects.toMatchObject({ status: 400 });
    expect(sendToGatewayMock).not.toHaveBeenCalled();
  });

  it('refuses a channel it has no way to deliver on instead of saving it as sent', async () => {
    reset();
    const db = sendPathDb([], {}, contact, 'whatsapp');
    await expect(send(db, { channelOverride: 'carrier_pigeon' as never })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('carrier_pigeon'),
    });
  });
});
