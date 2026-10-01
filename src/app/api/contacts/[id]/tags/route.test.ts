import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  assertTagIsContactTag: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireCapability: mocks.requireCapability,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: mocks.add,
}));

vi.mock('@/lib/contacts/tag-write', () => ({
  ContactTagWriteError: class ContactTagWriteError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
  removeContactTag: mocks.remove,
  assertTagIsContactTag: mocks.assertTagIsContactTag,
}));

import { DELETE, POST } from './route';
import { ContactTagWriteError } from '@/lib/contacts/tag-write';

const context = {
  supabase: { name: 'scoped-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
};

function request(method: 'POST' | 'DELETE', body: unknown) {
  return new Request('http://localhost/api/contacts/contact-1/tags', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'contact-1' }) };

beforeEach(() => {
  mocks.requireCapability.mockReset();
  mocks.add.mockReset();
  mocks.remove.mockReset();
  mocks.assertTagIsContactTag.mockReset();
  mocks.requireCapability.mockResolvedValue(context);
  mocks.assertTagIsContactTag.mockResolvedValue(undefined);
});

describe('/api/contacts/[id]/tags', () => {
  it('requires contacts.edit and dispatches a newly-added tag', async () => {
    mocks.add.mockResolvedValue({ added: true, dispatched: true });

    const response = await POST(request('POST', { tag_id: 'tag-1' }), params);

    expect(response.status).toBe(200);
    expect(mocks.requireCapability).toHaveBeenCalledWith('contacts.edit');
    expect(mocks.add).toHaveBeenCalledWith({
      db: context.supabase,
      accountId: 'account-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    });
  });

  it('rejects a missing tag id before writing', async () => {
    const response = await POST(request('POST', {}), params);
    expect(response.status).toBe(400);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('rejects a conversation-only tag before writing', async () => {
    mocks.assertTagIsContactTag.mockRejectedValue(
      new ContactTagWriteError('This tag is for conversations only.', 400)
    );

    const response = await POST(request('POST', { tag_id: 'tag-1' }), params);

    expect(response.status).toBe(400);
    expect(mocks.assertTagIsContactTag).toHaveBeenCalledWith(context.supabase, {
      accountId: 'account-1',
      tagId: 'tag-1',
    });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('removes a tag through the same account-scoped route', async () => {
    mocks.remove.mockResolvedValue(undefined);

    const response = await DELETE(
      request('DELETE', { tag_id: 'tag-1' }),
      params
    );

    expect(response.status).toBe(200);
    expect(mocks.requireCapability).toHaveBeenCalledWith('contacts.edit');
    expect(mocks.remove).toHaveBeenCalledWith(context.supabase, {
      accountId: 'account-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    });
  });
});
