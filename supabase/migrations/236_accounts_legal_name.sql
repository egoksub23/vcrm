-- migration 236: add legal_name to accounts
-- Stores the registered legal entity name, separate from the workspace
-- display name set by the tenant. Managed by the platform operator.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS legal_name TEXT;
