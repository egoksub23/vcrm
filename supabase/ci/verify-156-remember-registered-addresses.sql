-- Verify migration 156. Self-contained; run it with 156's migration text in front when the database
-- does not have it yet. Ends in a deliberate error so nothing is kept.
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_config' AND column_name = 'subscription_notification_url' AND data_type = 'text') THEN
    RAISE EXCEPTION 'FAIL email_config.subscription_notification_url is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jira_connections' AND column_name = 'webhook_url' AND data_type = 'text') THEN
    RAISE EXCEPTION 'FAIL jira_connections.webhook_url is missing';
  END IF;
  -- both are nullable, and existing rows read as "unknown"
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND is_nullable = 'NO'
         AND ((table_name = 'email_config' AND column_name = 'subscription_notification_url')
           OR (table_name = 'jira_connections' AND column_name = 'webhook_url'))) <> 0 THEN
    RAISE EXCEPTION 'FAIL a new address column is NOT NULL, which would break existing rows';
  END IF;
  RAISE EXCEPTION 'ROLLBACK-OK: email_config.subscription_notification_url and jira_connections.webhook_url exist as nullable text';
END
$verify$;
