-- ============================================================
-- 156: remember the address each external registration was made with.
--
-- A Microsoft 365 mail subscription and a Jira webhook both keep the callback
-- address they were created with: renewing extends them but never changes the
-- address. When Halo's own address changes (crm.vircle.tech -> halo.vircle.tech)
-- they quietly go on calling the old one. Storing the address lets the renewal
-- jobs notice a difference and recreate the registration by themselves, instead
-- of someone having to remember to clear it by hand.
--
-- A NULL means "created before this was recorded": the next renewal recreates it
-- once, which also records its address.
--
-- Idempotent.
-- ============================================================
ALTER TABLE public.email_config
  ADD COLUMN IF NOT EXISTS subscription_notification_url TEXT;

ALTER TABLE public.jira_connections
  ADD COLUMN IF NOT EXISTS webhook_url TEXT;
