-- Migration 207: PostgreSQL LISTEN/NOTIFY triggers for SSE-based realtime.
--
-- Replaces Supabase Realtime WebSocket subscriptions. Each table NOTIFY fires
-- on the per-account channel `halo_acct_<account_id>` (or `halo_user_<user_id>`
-- for `notifications`). The Next.js SSE route LISTENs on these channels and
-- streams events to the browser over a plain HTTP connection.
--
-- Payload format: {"table","eventType","new":{...row},"old":{...row}}
-- Payloads over 7900 bytes are truncated to {id, account_id, _truncated:true}.

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION halo_notify_account_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  acct_id text;
  payload text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      acct_id := (OLD).account_id::text;
    ELSE
      acct_id := (NEW).account_id::text;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    acct_id := NULL;
  END;

  IF acct_id IS NULL THEN
    RETURN NULL;
  END IF;

  payload := jsonb_build_object(
    'table',     TG_TABLE_NAME,
    'eventType', TG_OP,
    'new',       CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb ELSE to_jsonb(NEW) END,
    'old',       CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END
  )::text;

  IF octet_length(payload) > 7900 THEN
    -- Rebuild with minimal data only.
    payload := jsonb_build_object(
      'table',     TG_TABLE_NAME,
      'eventType', TG_OP,
      '_truncated', true,
      'new', CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (NEW).id, 'account_id', acct_id)
             END,
      'old', CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (OLD).id)
             END
    )::text;
  END IF;

  PERFORM pg_notify('halo_acct_' || acct_id, payload);
  RETURN NULL;
END;
$$;

-- For child tables whose account_id must be looked up via FK.
-- Caller passes the lookup SQL as TG_ARGV[0].
-- Pattern: 'SELECT account_id FROM public.tickets WHERE id = $1'
-- $1 is substituted with the parent FK value from NEW/OLD.

CREATE OR REPLACE FUNCTION halo_notify_child_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  acct_id text;
  parent_id text;
  payload text;
BEGIN
  -- The first trigger argument is the parent FK column name on the child table.
  -- The second is the parent table name (e.g. 'tickets', 'incidents').
  BEGIN
    IF TG_OP = 'DELETE' THEN
      EXECUTE format('SELECT ($1).%I::text', TG_ARGV[0]) INTO parent_id USING OLD;
    ELSE
      EXECUTE format('SELECT ($1).%I::text', TG_ARGV[0]) INTO parent_id USING NEW;
    END IF;

    IF parent_id IS NOT NULL THEN
      EXECUTE format('SELECT account_id::text FROM public.%I WHERE id = $1', TG_ARGV[1])
        INTO acct_id USING parent_id::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    acct_id := NULL;
  END;

  IF acct_id IS NULL THEN
    RETURN NULL;
  END IF;

  payload := jsonb_build_object(
    'table',     TG_TABLE_NAME,
    'eventType', TG_OP,
    'new',       CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb ELSE to_jsonb(NEW) END,
    'old',       CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END
  )::text;

  IF octet_length(payload) > 7900 THEN
    payload := jsonb_build_object(
      'table',     TG_TABLE_NAME,
      'eventType', TG_OP,
      '_truncated', true,
      'new', CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (NEW).id, 'account_id', acct_id)
             END,
      'old', CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (OLD).id)
             END
    )::text;
  END IF;

  PERFORM pg_notify('halo_acct_' || acct_id, payload);
  RETURN NULL;
END;
$$;

-- For conversation_events and message_reactions which carry conversation_id.
CREATE OR REPLACE FUNCTION halo_notify_via_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  acct_id text;
  conv_id text;
  payload text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      conv_id := (OLD).conversation_id::text;
    ELSE
      conv_id := (NEW).conversation_id::text;
    END IF;

    IF conv_id IS NOT NULL THEN
      SELECT account_id::text INTO acct_id
      FROM public.conversations WHERE id = conv_id::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    acct_id := NULL;
  END;

  IF acct_id IS NULL THEN
    RETURN NULL;
  END IF;

  payload := jsonb_build_object(
    'table',     TG_TABLE_NAME,
    'eventType', TG_OP,
    'new',       CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb ELSE to_jsonb(NEW) END,
    'old',       CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END
  )::text;

  IF octet_length(payload) > 7900 THEN
    payload := jsonb_build_object(
      'table',     TG_TABLE_NAME,
      'eventType', TG_OP,
      '_truncated', true,
      'new', CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (NEW).id, 'conversation_id', conv_id)
             END,
      'old', CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (OLD).id)
             END
    )::text;
  END IF;

  PERFORM pg_notify('halo_acct_' || acct_id, payload);
  RETURN NULL;
END;
$$;

-- For sign_signers which belong to sign_envelopes.
CREATE OR REPLACE FUNCTION halo_notify_via_envelope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  acct_id text;
  env_id text;
  payload text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      env_id := (OLD).envelope_id::text;
    ELSE
      env_id := (NEW).envelope_id::text;
    END IF;

    IF env_id IS NOT NULL THEN
      SELECT account_id::text INTO acct_id
      FROM public.sign_envelopes WHERE id = env_id::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    acct_id := NULL;
  END;

  IF acct_id IS NULL THEN
    RETURN NULL;
  END IF;

  payload := jsonb_build_object(
    'table',     TG_TABLE_NAME,
    'eventType', TG_OP,
    'new',       CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb ELSE to_jsonb(NEW) END,
    'old',       CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END
  )::text;

  IF octet_length(payload) > 7900 THEN
    payload := jsonb_build_object(
      'table',     TG_TABLE_NAME,
      'eventType', TG_OP,
      '_truncated', true,
      'new', CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (NEW).id)
             END,
      'old', CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (OLD).id)
             END
    )::text;
  END IF;

  PERFORM pg_notify('halo_acct_' || acct_id, payload);
  RETURN NULL;
END;
$$;

-- User-scoped (notifications table).
CREATE OR REPLACE FUNCTION halo_notify_user_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  uid text;
  payload text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      uid := (OLD).user_id::text;
    ELSE
      uid := (NEW).user_id::text;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    uid := NULL;
  END;

  IF uid IS NULL THEN
    RETURN NULL;
  END IF;

  payload := jsonb_build_object(
    'table',     TG_TABLE_NAME,
    'eventType', TG_OP,
    'new',       CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb ELSE to_jsonb(NEW) END,
    'old',       CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END
  )::text;

  IF octet_length(payload) > 7900 THEN
    payload := jsonb_build_object(
      'table',     TG_TABLE_NAME,
      'eventType', TG_OP,
      '_truncated', true,
      'new', CASE WHEN TG_OP = 'DELETE' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (NEW).id, 'user_id', uid)
             END,
      'old', CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb
                  ELSE jsonb_build_object('id', (OLD).id)
             END
    )::text;
  END IF;

  PERFORM pg_notify('halo_user_' || uid, payload);
  RETURN NULL;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers — tables with direct account_id column
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  DROP TRIGGER IF EXISTS halo_rt_messages ON public.messages;
  DROP TRIGGER IF EXISTS halo_rt_conversations ON public.conversations;
  DROP TRIGGER IF EXISTS halo_rt_member_presence ON public.member_presence;
  DROP TRIGGER IF EXISTS halo_rt_tickets ON public.tickets;
  DROP TRIGGER IF EXISTS halo_rt_ticket_links ON public.ticket_links;
  DROP TRIGGER IF EXISTS halo_rt_ticket_jira_links ON public.ticket_jira_links;
  DROP TRIGGER IF EXISTS halo_rt_ticket_mentions ON public.ticket_mentions;
  DROP TRIGGER IF EXISTS halo_rt_incidents ON public.incidents;
  DROP TRIGGER IF EXISTS halo_rt_sembang_messages ON public.sembang_messages;
  DROP TRIGGER IF EXISTS halo_rt_sembang_reactions ON public.sembang_reactions;
  DROP TRIGGER IF EXISTS halo_rt_sembang_pins ON public.sembang_pins;
  DROP TRIGGER IF EXISTS halo_rt_sembang_tasks ON public.sembang_tasks;
  DROP TRIGGER IF EXISTS halo_rt_sembang_link_previews ON public.sembang_link_previews;
  DROP TRIGGER IF EXISTS halo_rt_sembang_channels ON public.sembang_channels;
  DROP TRIGGER IF EXISTS halo_rt_sembang_channel_members ON public.sembang_channel_members;
  DROP TRIGGER IF EXISTS halo_rt_comments ON public.comments;
  DROP TRIGGER IF EXISTS halo_rt_sign_documents ON public.sign_documents;
  DROP TRIGGER IF EXISTS halo_rt_sign_envelopes ON public.sign_envelopes;
END $$;

CREATE TRIGGER halo_rt_messages
  AFTER INSERT OR UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_conversations
  AFTER INSERT OR UPDATE OR DELETE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_member_presence
  AFTER INSERT OR UPDATE OR DELETE ON public.member_presence
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_tickets
  AFTER INSERT OR UPDATE OR DELETE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_ticket_links
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_links
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_ticket_jira_links
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_jira_links
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_ticket_mentions
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_mentions
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_incidents
  AFTER INSERT OR UPDATE OR DELETE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sembang_messages
  AFTER INSERT OR UPDATE OR DELETE ON public.sembang_messages
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sembang_reactions
  AFTER INSERT OR UPDATE OR DELETE ON public.sembang_reactions
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sembang_pins
  AFTER INSERT OR UPDATE OR DELETE ON public.sembang_pins
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sembang_tasks
  AFTER INSERT OR UPDATE OR DELETE ON public.sembang_tasks
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sembang_link_previews
  AFTER INSERT OR UPDATE OR DELETE ON public.sembang_link_previews
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sembang_channels
  AFTER INSERT OR UPDATE OR DELETE ON public.sembang_channels
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sembang_channel_members
  AFTER INSERT OR UPDATE OR DELETE ON public.sembang_channel_members
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_comments
  AFTER INSERT OR UPDATE OR DELETE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sign_documents
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

CREATE TRIGGER halo_rt_sign_envelopes
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_envelopes
  FOR EACH ROW EXECUTE FUNCTION halo_notify_account_change();

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers — child tables (FK lookup for account_id)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  DROP TRIGGER IF EXISTS halo_rt_ticket_comments ON public.ticket_comments;
  DROP TRIGGER IF EXISTS halo_rt_ticket_activity ON public.ticket_activity;
  DROP TRIGGER IF EXISTS halo_rt_ticket_watchers ON public.ticket_watchers;
  DROP TRIGGER IF EXISTS halo_rt_ticket_attachments ON public.ticket_attachments;
  DROP TRIGGER IF EXISTS halo_rt_incident_comments ON public.incident_comments;
  DROP TRIGGER IF EXISTS halo_rt_incident_activity ON public.incident_activity;
  DROP TRIGGER IF EXISTS halo_rt_incident_attachments ON public.incident_attachments;
  DROP TRIGGER IF EXISTS halo_rt_incident_obligations ON public.incident_obligations;
  DROP TRIGGER IF EXISTS halo_rt_sign_signers ON public.sign_signers;
  DROP TRIGGER IF EXISTS halo_rt_conversation_events ON public.conversation_events;
  DROP TRIGGER IF EXISTS halo_rt_message_reactions ON public.message_reactions;
END $$;

-- ticket_* child tables
CREATE TRIGGER halo_rt_ticket_comments
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_comments
  FOR EACH ROW EXECUTE FUNCTION halo_notify_child_change('ticket_id', 'tickets');

CREATE TRIGGER halo_rt_ticket_activity
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_activity
  FOR EACH ROW EXECUTE FUNCTION halo_notify_child_change('ticket_id', 'tickets');

CREATE TRIGGER halo_rt_ticket_watchers
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_watchers
  FOR EACH ROW EXECUTE FUNCTION halo_notify_child_change('ticket_id', 'tickets');

CREATE TRIGGER halo_rt_ticket_attachments
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_attachments
  FOR EACH ROW EXECUTE FUNCTION halo_notify_child_change('ticket_id', 'tickets');

-- incident_* child tables
CREATE TRIGGER halo_rt_incident_comments
  AFTER INSERT OR UPDATE OR DELETE ON public.incident_comments
  FOR EACH ROW EXECUTE FUNCTION halo_notify_child_change('incident_id', 'incidents');

CREATE TRIGGER halo_rt_incident_activity
  AFTER INSERT OR UPDATE OR DELETE ON public.incident_activity
  FOR EACH ROW EXECUTE FUNCTION halo_notify_child_change('incident_id', 'incidents');

CREATE TRIGGER halo_rt_incident_attachments
  AFTER INSERT OR UPDATE OR DELETE ON public.incident_attachments
  FOR EACH ROW EXECUTE FUNCTION halo_notify_child_change('incident_id', 'incidents');

CREATE TRIGGER halo_rt_incident_obligations
  AFTER INSERT OR UPDATE OR DELETE ON public.incident_obligations
  FOR EACH ROW EXECUTE FUNCTION halo_notify_child_change('incident_id', 'incidents');

-- sign_signers via envelope
CREATE TRIGGER halo_rt_sign_signers
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_signers
  FOR EACH ROW EXECUTE FUNCTION halo_notify_via_envelope();

-- conversation-scoped tables
CREATE TRIGGER halo_rt_conversation_events
  AFTER INSERT OR UPDATE OR DELETE ON public.conversation_events
  FOR EACH ROW EXECUTE FUNCTION halo_notify_via_conversation();

CREATE TRIGGER halo_rt_message_reactions
  AFTER INSERT OR UPDATE OR DELETE ON public.message_reactions
  FOR EACH ROW EXECUTE FUNCTION halo_notify_via_conversation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers — user-scoped
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  DROP TRIGGER IF EXISTS halo_rt_notifications ON public.notifications;
END $$;

CREATE TRIGGER halo_rt_notifications
  AFTER INSERT OR UPDATE OR DELETE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION halo_notify_user_change();
