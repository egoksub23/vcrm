/**
 * "Claim on open": the first agent to open a still-live, unassigned
 * conversation is assigned it, so two agents never end up replying to the
 * same customer. A single conditional `UPDATE ... WHERE assigned_agent_id
 * IS NULL` is naturally race-safe under Postgres — if two agents open the
 * same conversation at once, only the first write's WHERE clause still
 * matches by the time it runs; the second affects zero rows and this
 * resolves to false for it. No RPC needed for that guarantee, same as
 * every other conversation write in this file (see MessageThread's
 * handleAssignChange) — this only adds the `.is(...)`/`.neq(...)`
 * conditions that make it "claim", not "overwrite".
 *
 * Returns true iff this call won the claim (the caller should patch its
 * own local state); false if someone else already had it, the
 * conversation was closed, or the write failed.
 */
export async function claimConversation(
  conversationId: string,
  _agentId: string,
): Promise<boolean> {
  const res = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/claim`,
    { method: 'POST' },
  ).catch(() => null);
  if (!res) return false;
  const json = (await res.json().catch(() => null)) as { claimed?: boolean } | null;
  return json?.claimed ?? false;
}
