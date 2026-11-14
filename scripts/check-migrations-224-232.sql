-- Read-only. Shows which of migrations 224-232 the database already has.
-- Run: ssh root@187.127.105.156 "docker exec -i wacrm-postgres-1 psql -U wacrm -d wacrm" < scripts/check-migrations-224-232.sql
SELECT m AS migration, CASE WHEN ok THEN 'applied' ELSE 'MISSING' END AS state
FROM (VALUES
  (224, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'incidents' AND column_name = 'voided_at')),
  (225, NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'incident_escalate_manual' AND prosrc LIKE '%incident_escalation_recipients%')),
  (226, to_regclass('public.incident_status_options') IS NOT NULL),
  (227, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'incident_settings' AND column_name = 'business_hours_schedule_id')),
  (228, to_regclass('public.incident_channel_settings') IS NOT NULL),
  (229, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'incident_comments' AND column_name = 'previous_versions')),
  (230, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'incidents' AND column_name = 'amend_reason')),
  (231, to_regclass('public.incident_school_webhooks') IS NOT NULL),
  (232, EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'usage_snapshot_run' AND pronargs = 2))
) v(m, ok)
ORDER BY m;
