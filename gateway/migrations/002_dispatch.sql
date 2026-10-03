-- Work package 2: the Halo side.
--
-- outbox_events.ord         strict order of events per workspace (created_at ties inside one transaction);
--                           the dispatcher sends a workspace's events in this order and never skips ahead
--                           of one that is waiting for a retry.
-- outbox_events.failed_at   an event Halo refused for good (a 4xx that a retry cannot fix) or that stayed
--                           undelivered past the retention window. It is kept for inspection, never retried.
-- messages.delivery         what the gateway did with a message from Halo (socket / push / queued /
--                           no_device), so a repeated Idempotency-Key returns the same answer.

ALTER TABLE outbox_events ADD COLUMN ord BIGSERIAL;
ALTER TABLE outbox_events ADD COLUMN failed_at TIMESTAMPTZ;

DROP INDEX IF EXISTS outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox_events (workspace_id, ord) WHERE dispatched_at IS NULL AND failed_at IS NULL;

ALTER TABLE messages ADD COLUMN delivery TEXT CHECK (delivery IN ('socket', 'push', 'queued', 'no_device'));
