import type { InboxView, InboxViewFilterConfig } from '@/types';

async function parseOrThrow(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as { error?: string } & Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(body.error ?? 'Inbox view request failed');
  }
  return body;
}

export async function createInboxView(input: {
  name: string;
  filterConfig: InboxViewFilterConfig;
  shared?: boolean;
}): Promise<InboxView> {
  const body = await parseOrThrow(
    await fetch('/api/inbox-views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        filter_config: input.filterConfig,
        shared: input.shared ?? false,
      }),
    })
  );
  return body.inbox_view as InboxView;
}

export async function deleteInboxView(id: string): Promise<void> {
  await parseOrThrow(await fetch(`/api/inbox-views/${id}`, { method: 'DELETE' }));
}
