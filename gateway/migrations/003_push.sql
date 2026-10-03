-- Work package 3: the delivery decision and push alerts.
--
-- A message from Halo that the app has not acknowledged (a `delivered` receipt) within a few seconds, or
-- that goes to a user with no live connection, makes the gateway ask the push API to alert the user.
-- One alert per conversation per away period:
--
--   conversations.alert_open     an alert was raised and the user has not been back since. It is cleared when
--                                the user connects, sends, or acknowledges anything. While it is set, further
--                                messages raise no further alert (until `last_alert_at` is old enough that a
--                                reminder is due).
--   conversations.push_fail_count / push_retry_at
--                                the push API failed in a way a retry may fix; wait until push_retry_at.
--   messages.push_checked_at     the alert decision for this message is made (alerted, covered by an earlier
--                                alert, nothing to alert with, or too old). NULL on a message the app has not
--                                acknowledged means the sweeper still has to look at it.
--   push_log                     every call to the push API and every decision not to make one, for the
--                                simulator's "push inbox" and for support.

ALTER TABLE conversations ADD COLUMN alert_open BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN last_alert_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN push_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN push_retry_at TIMESTAMPTZ;

ALTER TABLE messages ADD COLUMN push_checked_at TIMESTAMPTZ;
CREATE INDEX messages_unchecked_idx ON messages (created_at)
  WHERE direction = 'out' AND status = 'sent' AND push_checked_at IS NULL;

CREATE TABLE push_log (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       TEXT,
  outcome          TEXT NOT NULL CHECK (outcome IN ('sent', 'no_device', 'failed', 'skipped')),
  detail           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_log_conversation_idx ON push_log (conversation_id, created_at DESC);
