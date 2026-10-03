-- Work package 6 (simulator): users the simulator creates are flagged, so the delivery service always
-- sends their alerts to the mock push adapter and never to the real push API, whatever PUSH_ADAPTER is.
ALTER TABLE users ADD COLUMN simulated BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX users_simulated_idx ON users (workspace_id) WHERE simulated;
