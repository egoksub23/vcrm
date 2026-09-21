import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  tagRow: { current: null as unknown },
}));

vi.mock('@/lib/auth/account', () => ({
  requireCapability: mocks.requireCapability,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/conversations/label-events', () => ({
  addConversationLabelAndDispatch: mocks.add,
}));

vi.mock('@/lib/conversations/label-write', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/conversations/label-write')
  >('@/lib/conversations/label-write');
  return { ...actual, removeConversationLabel: mocks.remove };
});

import { DELETE, POST } from './route';

function scopedClient() {
  const builder: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'is']) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder.maybeSingle = vi
    .fn()
    .mockImplementation(async () => ({ data: mocks.tagRow.current, error: null }));
  return builder;
}

function request(method: 'POST' | 'DELETE', body: unknown) {
  return new Request('http://localhost/api/conversations/c1/labels', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'c1' }) };

beforeEach(() => {
  mocks.add.mockReset();
  mocks.remove.mockReset();
  mocks.requireCapability.mockReset();
  mocks.requireCapability.mockResolvedValue({
    supabase: scopedClient(),
    accountId: 'account-1',
    userId: 'user-1',
  });
});

describe('/api/conversations/[id]/labels', () => {
  it('attaches a conversation label', async () => {
    mocks.tagRow.current = { id: 't1', for_conversations: true };
    mocks.add.mockResolvedValue({ added: true, dispatched: true });

    const res = await POST(request('POST', { tag_id: 't1' }), params);

    expect(res.status).toBe(200);
    expect(mocks.requireCapability).toHaveBeenCalledWith('conversations.manage');
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it('rejects a contact-only tag with 400 and does not write', async () => {
    mocks.tagRow.current = { id: 't1', for_conversations: false };

    const res = await POST(request('POST', { tag_id: 't1' }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/contacts only/i);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('still lets a mis-attached contact-only label be removed', async () => {
    mocks.tagRow.current = { id: 't1', for_conversations: false };
    mocks.remove.mockResolvedValue(undefined);

    const res = await DELETE(request('DELETE', { tag_id: 't1' }), params);

    expect(res.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('requires a tag id', async () => {
    const res = await POST(request('POST', {}), params);
    expect(res.status).toBe(400);
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
