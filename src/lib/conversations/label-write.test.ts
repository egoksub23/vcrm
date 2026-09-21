import { describe, expect, it, vi } from 'vitest';

import {
  ConversationLabelWriteError,
  assertTagIsConversationLabel,
} from './label-write';

function stubDb(result: { data: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'is']) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder.maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: result.data, error: result.error ?? null });
  return builder as never;
}

const input = { accountId: 'a1', tagId: 't1' };

describe('assertTagIsConversationLabel', () => {
  it('accepts a conversation label', async () => {
    await expect(
      assertTagIsConversationLabel(
        stubDb({ data: { id: 't1', for_conversations: true } }),
        input
      )
    ).resolves.toBeUndefined();
  });

  it('accepts a legacy tag that has no scope flag (counts as both)', async () => {
    await expect(
      assertTagIsConversationLabel(
        stubDb({ data: { id: 't1', for_conversations: null } }),
        input
      )
    ).resolves.toBeUndefined();
  });

  it('rejects a contact-only tag with a 400 and a clear message', async () => {
    const err = await assertTagIsConversationLabel(
      stubDb({ data: { id: 't1', for_conversations: false } }),
      input
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConversationLabelWriteError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/contacts only/i);
  });

  it('leaves a missing / unapproved / deleted tag to the 404 in the write path', async () => {
    await expect(
      assertTagIsConversationLabel(stubDb({ data: null }), input)
    ).resolves.toBeUndefined();
  });

  it('surfaces a lookup failure as a 500', async () => {
    const err = await assertTagIsConversationLabel(
      stubDb({ data: null, error: { message: 'boom' } }),
      input
    ).catch((e) => e);
    expect(err.status).toBe(500);
  });
});
