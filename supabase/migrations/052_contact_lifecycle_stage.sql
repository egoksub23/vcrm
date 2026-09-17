-- ============================================================
-- 053_contact_lifecycle_stage
--
-- Unblocks the Lifecycle report (Reporting Suite follow-up) — Vircle
-- had no contact-lifecycle concept at all (the closest analog, Pipeline
-- deal stage, is sales-specific, not a general contact lifecycle).
--
-- Four stages, matching the CRM-standard progression: `lead` (default —
-- every new contact starts here, same as today's implicit behavior),
-- `active` (engaged in conversation), `customer` (converted), `churned`
-- (lost). Kept intentionally small — a workspace that wants a richer
-- funnel can still get there via custom fields; this covers the common
-- case respond.io's Lifecycle report tracks.
--
-- `lifecycle_stage_changed_at` records only the *most recent*
-- transition, not full history — there is no stage-history table. The
-- Lifecycle report's "moved to this stage in period X" number is
-- therefore an approximation (a contact that changed stage twice in
-- one day only shows its latest move), documented in the report UI
-- itself rather than silently presented as exact — same honesty
-- standard as the `closed_at` backfill approximation in migration 050.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT NOT NULL DEFAULT 'lead'
    CHECK (lifecycle_stage IN ('lead', 'active', 'customer', 'churned')),
  ADD COLUMN IF NOT EXISTS lifecycle_stage_changed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_lifecycle_stage ON contacts(account_id, lifecycle_stage);
