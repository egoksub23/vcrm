export async function mergeContacts(
  primaryContactId: string,
  secondaryContactId: string,
): Promise<void> {
  const res = await fetch('/api/contacts/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primary_contact_id: primaryContactId,
      secondary_contact_id: secondaryContactId,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? 'Merge failed');
  }
}
