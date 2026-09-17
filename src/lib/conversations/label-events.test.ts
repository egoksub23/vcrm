import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('./label-write', () => ({
  addConversationLabelIfAbsent: mocks.add,
}));

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mocks.dispatch,
}));

import {
  addConversationLabelAndDispatch,
} from './label-events';
import { MAX_TAG_CHAIN_DEPTH } from '@/lib/contacts/tag-chain';

function stubDb(contactId: string | null = 'contact-1') {
  const builder = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: contactId ? { contact_id: contactId } : null }),
  };
  return builder as never;
}

const base = {
  accountId: 'account-1',
  conversationId: 'conv-1',
  tagId: 'tag-1',
};

beforeEach(() => {
  mocks.add.mockReset();
  mocks.dispatch.mockReset();
  mocks.dispatch.mockResolvedValue(undefined);
});

describe('addConversationLabelAndDispatch', () => {
  it('dispatches once for a newly applied label and propagates depth', async () => {
    mocks.add.mockResolvedValue(true);
    const db = stubDb('contact-1');

    const result = await addConversationLabelAndDispatch({
      ...base,
      db,
      context: { vars: { source: 'inbox', _tag_chain_depth: 1 } },
    });

    expect(result).toEqual({ added: true, dispatched: true });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      accountId: 'account-1',
      triggerType: 'conversation_label_added',
      contactId: 'contact-1',
      context: {
        conversation_id: 'conv-1',
        tag_id: 'tag-1',
        vars: { source: 'inbox', _tag_chain_depth: 2 },
      },
    });
  });

  it('does not dispatch when the label is already present', async () => {
    mocks.add.mockResolvedValue(false);
    const db = stubDb();

    await expect(
      addConversationLabelAndDispatch({ ...base, db })
    ).resolves.toEqual({
      added: false,
      dispatched: false,
      reason: 'duplicate',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('adds the label but cuts a chain at the configured depth limit', async () => {
    mocks.add.mockResolvedValue(true);
    const db = stubDb();

    await expect(
      addConversationLabelAndDispatch({
        ...base,
        db,
        context: { vars: { _tag_chain_depth: MAX_TAG_CHAIN_DEPTH } },
      })
    ).resolves.toEqual({
      added: true,
      dispatched: false,
      reason: 'max_depth',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
