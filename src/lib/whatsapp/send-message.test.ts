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
type TestChannelType = 'whatsapp' | 'web_widget' | 'messenger' | 'instagram' | 'email';

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
  } = {},
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact,
    last_channel_type: channelType,
  };
  const config = {
    id: 'cfg-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };
  const messengerConfig =
    'messengerConfig' in configOverrides
      ? configOverrides.messengerConfig
      : { id: 'mc-1', page_id: 'page-1', page_access_token: 'page-token' };
  const instagramConfig =
    'instagramConfig' in configOverrides
      ? configOverrides.instagramConfig
      : { id: 'ic-1', ig_business_account_id: 'ig-1', page_access_token: 'page-token' };
  const emailConfig =
    'emailConfig' in configOverrides
      ? configOverrides.emailConfig
      : { id: 'ec-1', mailbox_address: 'agent@company.com' };
  const emailLastInboundMessageId = configOverrides.emailLastInboundMessageId ?? null;
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
          if (table === 'messenger_config' || table === 'instagram_config' || table === 'email_config') {
            configUpdates[table] = row;
          }
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'messages') {
            return emailLastInboundMessageId
              ? { data: { message_id: emailLastInboundMessageId }, error: null }
              : { data: null, error: null };
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

  it('rejects any non-text message_type for a widget conversation', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }, 'web_widget'),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'template', templateName: 'order_update' }
      )
    ).rejects.toThrow(/Only text messages are supported/);
  });
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
