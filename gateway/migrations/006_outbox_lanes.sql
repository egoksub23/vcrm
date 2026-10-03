-- Events for Halo are sent in parallel, one "lane" per conversation: order matters inside a conversation
-- (a reply must not reach Halo before the message it answers), not between two different people.
-- The lane is the conversation id; it is a column so the dispatcher can pick the head of every lane quickly.
ALTER TABLE outbox_events ADD COLUMN conversation_id TEXT;
UPDATE outbox_events SET conversation_id = payload->>'conversation_id' WHERE conversation_id IS NULL;
-- A receipt event carries only the message's server id; fill its lane from the message.
UPDATE outbox_events e SET conversation_id = m.conversation_id
  FROM messages m WHERE e.conversation_id IS NULL AND e.kind = 'message.receipt' AND m.id = e.payload->>'server_id';
CREATE INDEX outbox_lane_idx ON outbox_events (workspace_id, conversation_id, ord) WHERE dispatched_at IS NULL AND failed_at IS NULL;
